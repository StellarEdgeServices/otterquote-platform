/**
 * OtterQuote Edge Function: mark-job-complete
 *
 * LAUNCH-BLOCKER — ClickUp 86e0yvj7b
 * W2-P1 — May 1, 2026
 *
 * Allows a contractor to mark one of their won jobs as complete.
 * Sets claims.completion_date, writes an activity_log entry, and
 * emits a placeholder job_completed webhook event for future listeners.
 *
 * Authorization:
 *   - Caller must have a valid Supabase JWT (contractor)
 *   - Contractor must own a quote on the claim with status 'selected' or 'awarded'
 *
 * Idempotent:
 *   - If completion_date is already set, returns the existing timestamp
 *     with already_complete: true — no second write, no duplicate activity log row
 *
 * Input:  POST { claim_id: string }
 * Output: { completion_date: string, already_complete: boolean }
 *
 * Error codes:
 *   400 — missing or invalid claim_id
 *   401 — missing or invalid JWT
 *   403 — contractor has no 'selected'/'awarded' quote on this claim
 *   404 — claim not found
 *   409 — claim is not in a completable state (not contract_signed or awarded)
 *   500 — internal error
 *
 * Downstream listeners (NOT wired in this build — placeholder only):
 *   job_completed → process-hover-rebate, warranty-upload prompt, Lodge home-profile
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "mark-job-complete";

// States in which a contractor is allowed to mark a job complete.
// Other states (bidding, draft, submitted) mean no contractor has been
// selected yet — completing makes no sense.
const COMPLETABLE_STATES = ["contract_signed", "awarded"];

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

  // User-scoped client — used only to verify the JWT
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

    const claimId = (body.claim_id as string || "").trim();
    if (!claimId) {
      return jsonResponse({ ok: false, error: "claim_id is required" }, 400, corsHeaders);
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

    // ── Verify ownership: contractor must have a won quote on this claim ───────
    const { data: quote, error: quoteError } = await supabase
      .from("quotes")
      .select("id, status")
      .eq("claim_id", claimId)
      .eq("contractor_id", contractorId)
      .in("status", ["selected", "awarded"])
      .maybeSingle();

    if (quoteError) {
      console.error(`[${FUNCTION_NAME}] Quote lookup error:`, quoteError.message);
      return jsonResponse({ ok: false, error: "Internal error verifying job ownership" }, 500, corsHeaders);
    }

    if (!quote) {
      return jsonResponse({
        ok: false,
        error: "You do not have a won job on this claim, or the claim ID is invalid",
      }, 403, corsHeaders);
    }

    // ── Fetch claim ────────────────────────────────────────────────────────────
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("id, status, completion_date, property_address")
      .eq("id", claimId)
      .single();

    if (claimError || !claim) {
      return jsonResponse({ ok: false, error: "Claim not found" }, 404, corsHeaders);
    }

    // ── Idempotency: already complete ──────────────────────────────────────────
    if (claim.completion_date) {
      console.log(`[${FUNCTION_NAME}] Claim ${claimId} already complete at ${claim.completion_date} — returning existing timestamp`);
      return jsonResponse({
        ok: true,
        completion_date: claim.completion_date,
        already_complete: true,
      }, 200, corsHeaders);
    }

    // ── State guard: reject non-completable claims ─────────────────────────────
    if (!COMPLETABLE_STATES.includes(claim.status)) {
      return jsonResponse({
        ok: false,
        error: `Claim is in status '${claim.status}' and cannot be marked complete. Expected: ${COMPLETABLE_STATES.join(" or ")}.`,
      }, 409, corsHeaders);
    }

    // ── Set completion_date ────────────────────────────────────────────────────
    const completionDate = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("claims")
      .update({ completion_date: completionDate })
      .eq("id", claimId);

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to set completion_date on claim ${claimId}:`, updateError.message);
      return jsonResponse({ ok: false, error: "Failed to record job completion" }, 500, corsHeaders);
    }

    // ── Write activity_log ─────────────────────────────────────────────────────
    const address = claim.property_address || "a project";
    const { error: logError } = await supabase
      .from("activity_log")
      .insert({
        user_id:    authUserId,
        event_type: "job_completed",
        title:      `Job marked complete for ${address}`,
        metadata: {
          claim_id:     claimId,
          quote_id:     quote.id,
          marked_by:    contractorId,
          completed_at: completionDate,
        },
      });

    if (logError) {
      // Non-fatal — completion_date is already written. Log and continue.
      console.error(`[${FUNCTION_NAME}] activity_log insert failed (non-fatal):`, logError.message);
    }

    // ── Placeholder webhook event (downstream listeners NOT wired in W2-P1) ────
    console.log(
      `[${FUNCTION_NAME}] [job_completed] claim_id=${claimId} quote_id=${quote.id} ` +
      `contractor_id=${contractorId} completed_at=${completionDate} ` +
      `— downstream listeners not wired (W2-P1 scope). Future: process-hover-rebate, warranty-upload, Lodge home-profile.`
    );

    console.log(`[${FUNCTION_NAME}] Job marked complete — claim ${claimId} by contractor ${contractorId}`);

    return jsonResponse({
      ok: true,
      completion_date: completionDate,
      already_complete: false,
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
