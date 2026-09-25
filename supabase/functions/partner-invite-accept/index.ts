/**
 * OtterQuote Edge Function: partner-invite-accept
 *
 * gh-2154 P-5r (LEGAL-READ FAIL 5833717530) — the accept step a Meta Lead
 * Ads partner reaches through their signed invite link. meta-leadgen-webhook
 * now inserts a Meta-sourced referral_agents row with status='pending' and
 * NO agreement stamp (see the P-5 migration's LEGAL-READ note) because the
 * lead never saw OtterQuote's Partner Terms checkbox — only Meta's own
 * lead-ad consent. This function is how that partner actually accepts
 * v3-2026-09 and gets activated, the same two facts P-1's own signup forms
 * record on submit (partner_agreement_version/accepted_at/attestation,
 * status='active') — just reached through an invite link instead of a cold
 * signup.
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────
 * GET  ?t=<token>  — verifies the signed invite token (same HMAC mechanism
 *   as D-320's opt-out links, namespaced "invite:", see invite-token.ts).
 *   On a verified token whose row is still status='pending' with a
 *   meta_lead_id set (i.e. actually invite-eligible — never any other
 *   referral_agents row, even if someone forged a syntactically valid
 *   token for one), returns JSON prefill data for the P-1 form:
 *   { ok:true, agent_type, first_name, last_name, email }. Anything else
 *   (bad signature, unknown id, already-active, not a webhook-sourced row)
 *   returns the SAME 404 { ok:false } — no state is distinguishable from
 *   "this token does not work," so this is not an enumeration oracle.
 *
 * POST { t, agreement_accepted:true } — re-verifies the token, then, only
 *   if agreement_accepted is exactly boolean true, activates the row:
 *   status -> 'active', partner_agreement_version -> 'v3-2026-09',
 *   partner_agreement_accepted_at -> now(), partner_agreement_attestation ->
 *   { 'v3-2026-09': { accepted_ip, accepted_ua, accepted_at } } — same
 *   shape register_partner() writes for every other partner, so this row
 *   ends up indistinguishable from one that accepted at signup. Idempotent:
 *   a second POST (double-click, retry) with the same token is a no-op
 *   200, not an error — the WHERE status='pending' guard on the UPDATE
 *   means only the first accept actually writes.
 *   agreement_accepted missing/false -> 400, no write (the checkbox is a
 *   hard gate here too, same as P-1's own forms).
 *
 * This function does NOT create a Supabase Auth account or sign the partner
 * in — it only flips the referral_agents row. Setting a password / signing
 * in still goes through partner-login.html's existing "Forgot password?"
 * flow, same as any P-1-created partner whose first visit is via magic
 * link. That is an explicit scope cut for this build, not an oversight —
 * see this build's report.
 *
 * verify_jwt = false in config.toml: an invited partner has no Supabase JWT
 * yet. The signed token IS the authorization.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   PARTNER_INVITE_SECRET, PARTNER_INVITE_SECRET_PREVIOUS (optional)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  PARTNER_INVITE_SECRET_ENV,
  PARTNER_INVITE_SECRET_PREVIOUS_ENV,
  verifyPartnerInviteToken,
} from "./invite-token.ts";

const FUNCTION_NAME = "partner-invite-accept";
const AGREEMENT_VERSION = "v3-2026-09";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function notFound(): Response {
  // Uniform for: bad signature, unknown id, already-active, non-webhook row.
  return jsonResponse({ ok: false, error: "not_found" }, 404);
}

/**
 * Whether a referral_agents row is invite-eligible — extracted as a pure
 * function (no supabase-js import) so it is unit-testable without a real
 * client or network access. A row is eligible only if it is still
 * status='pending' AND has a meta_lead_id (i.e. it was actually created by
 * meta-leadgen-webhook, never any other 'pending' row a future caller might
 * one day create for an unrelated reason).
 */
export function isInviteEligible(row: { status?: string | null; meta_lead_id?: string | null } | null | undefined): boolean {
  if (!row) return false;
  return row.status === "pending" && typeof row.meta_lead_id === "string" && row.meta_lead_id.length > 0;
}

/** The accept POST body is valid only when agreement_accepted is exactly
 * boolean true — the same hard-gate posture as P-1's own checkbox (no
 * truthy-string, no missing-field-defaults-to-accepted). */
export function isValidAcceptBody(body: { agreement_accepted?: unknown } | null | undefined): boolean {
  return !!body && body.agreement_accepted === true;
}

async function readToken(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const t = body?.t;
      return typeof t === "string" && t.length > 0 ? t : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

// Guarded like notify-admin-new-partner/index.ts and send-home-profile-
// prompt/index.ts: `deno test` imports this module to reach
// isInviteEligible/isValidAcceptBody, and import.meta.main is false in that
// case, so serve() never binds a listener during tests.
if (import.meta.main) {
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" },
    });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const token = await readToken(req);
    const secrets = [
      Deno.env.get(PARTNER_INVITE_SECRET_ENV) || "",
      Deno.env.get(PARTNER_INVITE_SECRET_PREVIOUS_ENV) || "",
    ].filter((s) => s.length > 0);

    if (secrets.length === 0) {
      console.error(`[${FUNCTION_NAME}] ${PARTNER_INVITE_SECRET_ENV} is not set — cannot verify any invite token`);
      return notFound();
    }

    const referralAgentId = await verifyPartnerInviteToken(token, secrets);
    if (!referralAgentId) {
      return notFound();
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error(`[${FUNCTION_NAME}] server configuration error`);
      return jsonResponse({ ok: false, error: "server_error" }, 500);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (req.method === "GET") {
      // Only a still-pending, webhook-sourced row is invite-eligible — a
      // token for any other row (already active, or not Meta-sourced at
      // all) behaves exactly like an invalid token.
      const { data, error } = await supabase
        .from("referral_agents")
        .select("agent_type, first_name, last_name, email, status, meta_lead_id")
        .eq("id", referralAgentId)
        .limit(1)
        .maybeSingle();
      if (error || !data || !isInviteEligible(data)) {
        return notFound();
      }
      return jsonResponse({
        ok: true,
        agent_type: data.agent_type,
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
      }, 200);
    }

    // POST — accept.
    let body: { agreement_accepted?: unknown } = {};
    try {
      body = await req.clone().json();
    } catch (_) {
      // readToken() above already consumed req.json() once for a POST
      // without ?t= — req.clone() lets both reads happen safely regardless
      // of which path supplied the token.
    }
    if (!isValidAcceptBody(body)) {
      return jsonResponse({ ok: false, error: "agreement_not_accepted" }, 400);
    }

    const headers = req.headers;
    const ip = headers.get("cf-connecting-ip") ||
      (headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      headers.get("x-real-ip") || null;
    const ua = headers.get("user-agent");

    const { data: updated, error: updateErr } = await supabase
      .from("referral_agents")
      .update({
        status: "active",
        partner_agreement_version: AGREEMENT_VERSION,
        partner_agreement_accepted_at: new Date().toISOString(),
        partner_agreement_attestation: {
          [AGREEMENT_VERSION]: { accepted_ip: ip, accepted_ua: ua, accepted_at: new Date().toISOString() },
        },
      })
      .eq("id", referralAgentId)
      .eq("status", "pending")
      .not("meta_lead_id", "is", null)
      .select("id")
      .maybeSingle();

    if (updateErr) {
      console.error(`[${FUNCTION_NAME}] failed to record acceptance for ${referralAgentId}: ${updateErr.message}`);
      return jsonResponse({ ok: false, error: "server_error" }, 500);
    }

    // No row matched the WHERE guard: either already accepted (idempotent
    // — a second click is not an error) or the id no longer qualifies.
    // Both look identical to the caller: ok:true. A row that genuinely
    // never existed already returned 404 above via the same GET-path
    // eligibility check the client necessarily called first to prefill the
    // form, so reaching POST with a bogus id is not a normal client flow.
    if (!updated) {
      console.log(`[${FUNCTION_NAME}] accept for ${referralAgentId}: no pending row matched (already accepted or ineligible)`);
    } else {
      console.log(`[${FUNCTION_NAME}] activated partner ${referralAgentId} via invite accept`);
    }
    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected failure: ${String(err)}`);
    return jsonResponse({ ok: false, error: "server_error" }, 500);
  }
});
}
