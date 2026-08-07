/**
 * OtterQuote Edge Function: get-hover-pdf
 *
 * On-demand Hover PDF fetch endpoint.
 * hover-webhook no longer stores PDFs (Session 61 — storage cost decision).
 * This function fetches the Hover measurement PDF from Hover's API
 * at the time it is needed and returns it as a signed, time-limited URL
 * via Supabase Storage, or streams it directly as a PDF response.
 *
 * Usage:
 *   POST /functions/v1/get-hover-pdf
 *   Body: { "claim_id": "...", "format": "url" | "stream" }
 *     - format "url"    → stores PDF in Supabase Storage and returns a signed URL (10 min TTL)
 *     - format "stream" → streams PDF bytes directly (default)
 *
 * Auth: Requires valid Supabase JWT (homeowner must own the claim,
 *       or service role for admin use).
 *
 * Rate limit: 20/day, 50/month per claim (via check_rate_limit RPC).
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_CLIENT_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOVER_API_BASE = "https://hover.to";
const FUNCTION_NAME = "get-hover-pdf";
const STORAGE_BUCKET = "claim-documents";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // ── Parse request ──────────────────────────────────────────────
    const { claim_id, format = "stream" } = await req.json();

    if (!claim_id) {
      return new Response(
        JSON.stringify({ error: "Missing required field: claim_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Authenticate & authorize caller ────────────────────────────
    // Service role skips auth (admin/internal use). Every other caller must
    // present a valid user JWT AND be associated with the claim — see
    // canAccessClaim(). (D-211 Phase 16 Unit 2 — Hover IDOR fix: the prior gate
    // allowed ANY active contractor to pull ANY claim's PDF, and a request with
    // no Authorization header skipped the ownership check entirely.)
    let rateLimitUserId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    const isServiceRole = !!authHeader && authHeader.includes(supabaseKey);
    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || supabaseKey, {
        global: { headers: { Authorization: authHeader ?? "" } },
      });
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      rateLimitUserId = user.id;
      const allowed = await canAccessClaim(supabase, claim_id, user);
      if (!allowed) {
        return new Response(
          JSON.stringify({ error: "Claim not found or access denied" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Rate limit ─────────────────────────────────────────────────
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: rateLimitUserId,
    });

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({ error: "Rate limit check failed" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!rateLimitResult?.allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded", reason: rateLimitResult?.reason }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Look up hover_order for this claim ─────────────────────────
    const { data: order, error: orderError } = await supabase
      .from("hover_orders")
      .select("id, hover_job_id, status, measurements_json")
      .eq("claim_id", claim_id)
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (orderError || !order) {
      return new Response(
        JSON.stringify({
          error: "No completed Hover measurement order found for this claim",
          detail: "Hover measurements must be ordered and completed before the PDF can be fetched",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jobId = order.hover_job_id;
    if (!jobId) {
      return new Response(
        JSON.stringify({ error: "Hover job ID not found on order record" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Cache-first (#484 item 2 / #588 Phase 1) ───────────────────
    // A previously fetched copy lives at the canonical cache path. Serve it
    // before re-hitting the Hover API — this is what would have kept the
    // button alive during the 2026-07-07 platform-wide Hover outage, and it
    // is the same path hover-webhook now records on claims.measurements_filename.
    const cachePath = `${claim_id}/hover_measurements_${order.hover_job_id}.pdf`;
    try {
      const { data: cachedBlob } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(cachePath);
      if (cachedBlob) {
        console.log(`Serving cached Hover PDF from ${STORAGE_BUCKET}/${cachePath}`);
        if (format === "url") {
          const { data: signedData, error: signError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .createSignedUrl(cachePath, 600);
          if (!signError && signedData?.signedUrl) {
            return new Response(
              JSON.stringify({ success: true, url: signedData.signedUrl, expires_in: 600, job_id: order.hover_job_id, claim_id, cached: true }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          // Signing failure on a cached object: fall through to the API path.
        } else {
          const cachedBytes = await cachedBlob.arrayBuffer();
          return new Response(cachedBytes, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="hover_measurements_${order.hover_job_id}.pdf"`,
              "Content-Length": cachedBytes.byteLength.toString(),
            },
          });
        }
      }
    } catch (cacheErr) {
      // Cache miss/error is expected on first fetch — fall through to the API.
      console.log(`No cached Hover PDF at ${cachePath} (${cacheErr instanceof Error ? cacheErr.message : "miss"}); fetching from Hover API`);
    }

    // ── Get valid Hover access token ───────────────────────────────
    const accessToken = await getValidAccessToken(supabase);
    if (!accessToken) {
      return new Response(
        JSON.stringify({
          error: "Hover authentication failed — no valid access token",
          detail: "OtterQuote's Hover OAuth token may need re-authorization",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch PDF from Hover API ───────────────────────────────────
    console.log(`Fetching Hover PDF for job_id=${jobId}`);
    const pdfResponse = await fetch(
      `${HOVER_API_BASE}/api/v1/jobs/${jobId}/measurements.pdf`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/pdf",
        },
      }
    );

    if (!pdfResponse.ok) {
      console.error(`Hover PDF fetch failed: ${pdfResponse.status} ${pdfResponse.statusText}`);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch PDF from Hover",
          status: pdfResponse.status,
          detail: pdfResponse.statusText,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const pdfBytes = await pdfResponse.arrayBuffer();
    console.log(`PDF fetched: ${pdfBytes.byteLength} bytes for job ${jobId}`);

    // ── Return PDF ─────────────────────────────────────────────────
    if (format === "url") {
      // Upload to Supabase Storage under claim-documents/{claim_id}/hover_measurements.pdf
      // then return a signed URL with 10-minute TTL
      const storagePath = `${claim_id}/hover_measurements_${jobId}.pdf`;

      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, pdfBytes, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadError) {
        console.error("Storage upload failed:", uploadError);
        return new Response(
          JSON.stringify({ error: "Failed to store PDF", detail: uploadError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: signedData, error: signError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(storagePath, 600); // 10-minute TTL

      if (signError || !signedData?.signedUrl) {
        return new Response(
          JSON.stringify({ error: "Failed to generate signed URL" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          url: signedData.signedUrl,
          expires_in: 600,
          job_id: jobId,
          claim_id,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      // Stream PDF directly — and populate the cache first (best-effort) so
      // the next request is served cache-first regardless of format (#484).
      try {
        await supabase.storage.from(STORAGE_BUCKET).upload(cachePath, pdfBytes, {
          contentType: "application/pdf",
          upsert: true,
        });
      } catch (cacheWriteErr) {
        console.warn("Cache write failed (non-fatal):", cacheWriteErr);
      }
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="hover_measurements_${jobId}.pdf"`,
          "Content-Length": pdfBytes.byteLength.toString(),
        },
      });
    }
  } catch (error) {
    console.error(`${FUNCTION_NAME} error:`, error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});


// ── Authorization (D-211 Phase 16 Unit 2 — Hover IDOR fix) ─────────
//
// canAccessClaim mirrors the `claims`-table RLS SELECT boundary exactly — the
// platform's canonical "which claims may this caller see" rule:
//   (1) Homeowner who owns the claim          → claims.user_id = caller
//   (2) Active contractor + released biddable → RLS "Contractors can view
//       biddable claims" (sql/v10): ready_for_bids = true AND status IN
//       ('active','bidding','pending') AND the caller has an active contractor
//       record.
//   (3) Contractor with an existing quote     → RLS "Contractors can view claims
//       for their quotes" (sql/v20 + v21): a quote on this claim by one of the
//       caller's contractor records.
//
// The opportunities trade / ZIP-distance / 6-bid filters are client-side DISPLAY
// refinements, NOT an access boundary, so they are intentionally not replicated
// here (replicating them would over-restrict and break legitimate browsing).
//
// `supabase` is the service-role client; the predicate is enforced explicitly.
async function canAccessClaim(
  supabase: any,
  claimId: string,
  user: { id: string },
): Promise<boolean> {
  // (1) Homeowner ownership.
  const { data: claim } = await supabase
    .from("claims")
    .select("user_id, ready_for_bids, status")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return false; // unknown claim → deny
  if (claim.user_id === user.id) return true;

  // Resolve the caller's contractor record(s) once (a user may own more than one).
  const { data: contractors } = await supabase
    .from("contractors")
    .select("id, status")
    .eq("user_id", user.id);
  const contractorRows = (contractors ?? []) as { id: string; status: string | null }[];
  if (contractorRows.length === 0) return false; // not the owner and not a contractor

  // (2) Active contractor + released, biddable claim.
  const biddable =
    claim.ready_for_bids === true &&
    ["active", "bidding", "pending"].includes(claim.status);
  if (biddable && contractorRows.some((c) => c.status === "active")) {
    return true;
  }

  // (3) Contractor associated via an existing quote/selection on this claim.
  const { data: quote } = await supabase
    .from("quotes")
    .select("id")
    .eq("claim_id", claimId)
    .in("contractor_id", contractorRows.map((c) => c.id))
    .limit(1)
    .maybeSingle();
  if (quote) return true;

  return false;
}


// ── Token management (same pattern as hover-webhook) ──────────────

async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !tokens || tokens.length === 0) {
    console.error("No Hover tokens in hover_tokens table");
    return null;
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // Still valid (with 5-minute buffer)
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  // Refresh
  const clientId = Deno.env.get("HOVER_CLIENT_ID")!;
  const clientSecret = Deno.env.get("HOVER_CLIENT_SECRET")!;

  const refreshResponse = await fetch(`${HOVER_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
    }),
  });

  if (!refreshResponse.ok) {
    console.error("Hover token refresh failed:", refreshResponse.status);
    return null;
  }

  const newTokenData = await refreshResponse.json();
  const newExpiresAt = new Date(
    Date.now() + (newTokenData.expires_in || 7200) * 1000
  ).toISOString();

  await supabase
    .from("hover_tokens")
    .update({
      access_token: newTokenData.access_token,
      refresh_token: newTokenData.refresh_token || token.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq("id", token.id);

  return newTokenData.access_token;
}
