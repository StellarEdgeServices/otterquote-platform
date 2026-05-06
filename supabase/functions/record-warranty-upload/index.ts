/**
 * OtterQuote Edge Function: record-warranty-upload
 *
 * W3-P4 — May 1, 2026 — ClickUp 86e0yvj7w
 *
 * Records a contractor's warranty PDF upload on a completed job.
 * The PDF has already been uploaded to Supabase Storage by the client.
 * This function validates ownership, writes the storage path + timestamp
 * to quotes, and inserts an activity_log entry.
 *
 * Authorization:
 *   - Caller must have a valid Supabase JWT (contractor)
 *   - Contractor must own a quote with status 'selected'/'awarded' on the claim
 *   - Claim must have completion_date set (job must be marked complete first)
 *
 * Idempotent / Replacement allowed:
 *   - Re-uploading is explicitly supported; the row is updated in place.
 *   - activity_log records both old and new: replaced_previous=true on second upload.
 *
 * Input:  POST { quote_id: string, storage_path: string }
 * Output: { ok: true, warranty_uploaded_at: string }
 *
 * Error codes:
 *   400 — missing/invalid inputs or malformed storage path
 *   401 — missing or invalid JWT
 *   403 — contractor does not own this quote, or job not yet complete
 *   404 — quote not found
 *   429 — rate limit exceeded
 *   500 — internal error
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "record-warranty-upload";

const STORAGE_PATH_PREFIX = "contractor-documents/warranties/";
const STORAGE_PATH_SUFFIX = ".pdf";

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

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon   = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(`[${FUNCTION_NAME}] Missing required environment variables`);
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── Authenticate caller ────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Missing authorization token" }, 401, corsHeaders);
  }

  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid or expired token" }, 401, corsHeaders);
  }

  const authUserId = userData.user.id;

  // Service role client for all DB writes
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // ── Rate limiting ──────────────────────────────────────────────────────────
    const { data: rlOk, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: authUserId,
    });
    if (rlError) {
      console.warn(`[${FUNCTION_NAME}] Rate limit RPC error (non-fatal):`, rlError.message);
    } else if (!rlOk) {
      return jsonResponse({ ok: false, error: "Rate limit exceeded — please try again shortly" }, 429, corsHeaders);
    }

    // ── Parse body ─────────────────────────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_) {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const quoteId     = (body.quote_id     as string || "").trim();
    const storagePath = (body.storage_path as string || "").trim();

    if (!quoteId) {
      return jsonResponse({ ok: false, error: "quote_id is required" }, 400, corsHeaders);
    }
    if (!storagePath) {
      return jsonResponse({ ok: false, error: "storage_path is required" }, 400, corsHeaders);
    }

    // ── Validate storage path format ───────────────────────────────────────────
    // Must live inside contractor-documents/warranties/ and be a PDF.
    if (
      !storagePath.startsWith(STORAGE_PATH_PREFIX) ||
      !storagePath.toLowerCase().endsWith(STORAGE_PATH_SUFFIX)
    ) {
      return jsonResponse({
        ok: false,
        error: `storage_path must start with '${STORAGE_PATH_PREFIX}' and end with '.pdf'`,
      }, 400, corsHeaders);
    }

    // ── Resolve contractor record ──────────────────────────────────────────────
    const { data: contractor, error: contractorError } = await supabase
      .from("contractors")
      .select("id, status")
      .eq("user_id", authUserId)
      .single();

    if (contractorError || !contractor) {
      console.error(`[${FUNCTION_NAME}] Contractor lookup failed for user ${authUserId}:`, contractorError?.message);
      return jsonResponse({ ok: false, error: "Contractor account not found" }, 403, corsHeaders);
    }

    const contractorId = contractor.id;

    // ── Fetch quote + claim in one query ────────────────────────────────────────
    const { data: quote, error: quoteError } = await supabase
      .from("quotes")
      .select("id, status, claim_id, warranty_document_url, claims(id, completion_date)")
      .eq("id", quoteId)
      .eq("contractor_id", contractorId)
      .maybeSingle();

    if (quoteError) {
      console.error(`[${FUNCTION_NAME}] Quote lookup error:`, quoteError.message);
      return jsonResponse({ ok: false, error: "Internal error fetching quote" }, 500, corsHeaders);
    }

    if (!quote) {
      return jsonResponse({
        ok: false,
        error: "Quote not found or you do not own this quote",
      }, 404, corsHeaders);
    }

    // ── Authorization: quote must be won ───────────────────────────────────────
    if (!["selected", "awarded"].includes(quote.status)) {
      return jsonResponse({
        ok: false,
        error: `Quote status '${quote.status}' is not eligible for warranty upload. Expected: selected or awarded.`,
      }, 403, corsHeaders);
    }

    // ── Authorization: job must be marked complete ─────────────────────────────
    const claim = (quote.claims as Record<string, unknown>) || {};
    if (!claim.completion_date) {
      return jsonResponse({
        ok: false,
        error: "Job must be marked complete before a warranty can be uploaded.",
      }, 403, corsHeaders);
    }

    const replacingPrevious = !!(quote.warranty_document_url);
    const previousPath = quote.warranty_document_url || null;
    const uploadedAt   = new Date().toISOString();

    // ── Write warranty_document_url + warranty_uploaded_at ─────────────────────
    const { error: updateError } = await supabase
      .from("quotes")
      .update({
        warranty_document_url: storagePath,
        warranty_uploaded_at:  uploadedAt,
      })
      .eq("id", quoteId);

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to update quote ${quoteId}:`, updateError.message);
      return jsonResponse({ ok: false, error: "Failed to record warranty upload" }, 500, corsHeaders);
    }

    // ── Write activity_log ─────────────────────────────────────────────────────
    const { error: logError } = await supabase
      .from("activity_log")
      .insert({
        user_id:    authUserId,
        event_type: "warranty_uploaded",
        title:      replacingPrevious
          ? `Warranty document replaced for claim ${quote.claim_id}`
          : `Warranty document uploaded for claim ${quote.claim_id}`,
        metadata: {
          quote_id:          quoteId,
          claim_id:          quote.claim_id,
          contractor_id:     contractorId,
          storage_path:      storagePath,
          replaced_previous: replacingPrevious,
          previous_path:     previousPath,
          uploaded_at:       uploadedAt,
        },
      });

    if (logError) {
      // Non-fatal — warranty URL is already written; log and continue.
      console.error(`[${FUNCTION_NAME}] activity_log insert failed (non-fatal):`, logError.message);
    }

    console.log(
      `[${FUNCTION_NAME}] Warranty recorded — quote ${quoteId} ` +
      `claim ${quote.claim_id} contractor ${contractorId} ` +
      `replaced=${replacingPrevious}`
    );

    return jsonResponse({
      ok: true,
      warranty_uploaded_at: uploadedAt,
      replaced_previous:    replacingPrevious,
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
