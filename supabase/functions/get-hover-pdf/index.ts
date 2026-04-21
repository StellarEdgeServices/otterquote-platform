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
  "https://jade-alpaca-b82b5e.netlify.app",
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

    // ── Authenticate caller ────────────────────────────────────────
    // Service role skips auth. Anon/JWT callers must own the claim.
    const authHeader = req.headers.get("Authorization");
    if (authHeader && !authHeader.includes(supabaseKey)) {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || supabaseKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Verify ownership
      const { data: claim, error: claimErr } = await supabase
        .from("claims")
        .select("id, user_id")
        .eq("id", claim_id)
        .single();
      if (claimErr || !claim || claim.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: "Claim not found or access denied" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Rate limit ─────────────────────────────────────────────────
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: claim_id,
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
      // Stream PDF directly
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
