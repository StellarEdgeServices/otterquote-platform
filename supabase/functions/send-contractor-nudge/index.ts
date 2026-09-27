/**
 * OtterQuote Edge Function: send-contractor-nudge
 *
 * gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44, fresh-context REVIEW+LEGAL-READ
 * FAIL 5856738126 on PR #2252): the prior fix on this branch made
 * get-contractor-info return a contractor's phone, notification_phones,
 * sms_opt_in, sms_opt_in_at and sms_consent_text_version to the claim's
 * homeowner unconditionally, so the browser could client-side-gate the
 * "haven't heard from your contractor" nudge on sms_opt_in === true. REVIEW
 * failed it: that handed the homeowner phone numbers and consent metadata
 * they had never received before (new disclosure, no D-number behind it), and
 * a client-side gate is not something a browser caller is ever obligated to
 * honor — a homeowner holding a non-consented contractor's number could call
 * send-sms directly.
 *
 * Marty's ruling: consent enforcement is SERVER-SIDE. No contractor phone
 * number or consent metadata goes to the browser. This function is the single
 * choke point for that nudge (formerly contract-signing.html:1731-1778 /
 * use-contract-signing-data.ts sendContractorNudge, which built the message
 * and gated in the browser): it looks up the contractor's phone(s) and
 * `sms_opt_in` itself with the service role, refuses + logs when
 * `sms_opt_in` is not strictly `true` (D-328 — "No contractor SMS send path
 * may fire without contractors.sms_opt_in = true ... Applies to
 * notify-contractors, process-dunning, the contract-signing 'haven't heard
 * from your contractor' nudge ... and any future sender"), and never returns
 * a phone number or consent field in its response — only
 * `{ ok, contractorNotified, dustinNotified }`.
 *
 * Auth: verify_jwt = true (config.toml). Caller must be authenticated AND be
 * the claim's homeowner (claim.user_id === callerId) — this nudge is a
 * homeowner-initiated action only ("haven't heard from your contractor?");
 * unlike get-contractor-info, the contractor itself has no legitimate reason
 * to trigger its own nudge, so only the homeowner branch is accepted here.
 * The contractor must also actually be linked to this claim (via
 * selected_contractor_id or a quote), matching get-contractor-info's own
 * linkage check, so a homeowner cannot nudge an unrelated contractor.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { attemptContractorSms } from "./consent-gate.ts";

const ALLOWED_ORIGINS = [
  "https://stellaredgeservices.com",
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

// Dustin's alert line — byte-for-parity with the retired client-side nudge
// (contract-signing.html:1762 / use-contract-signing-data.ts's former
// NUDGE_DUSTIN_PHONE). Dustin is always alerted, independent of the
// contractor's consent state — this is not a contractor SMS send and D-328
// does not gate it.
const DUSTIN_ALERT_PHONE = "+13175019215";

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const token = authHeader.slice(7);

  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const callerId = user.id;

  let claim_id: string, contractor_id: string;
  try {
    const body = await req.json();
    claim_id = body.claim_id;
    contractor_id = body.contractor_id;
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!claim_id || !contractor_id) {
    return json({ error: "Missing required fields: claim_id, contractor_id" }, 400, corsHeaders);
  }

  const { data: claim, error: claimErr } = await sb
    .from("claims")
    .select("id, user_id, selected_contractor_id, homeowner_name, property_address, contract_signed_at")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Homeowner-only: the contractor has no legitimate reason to trigger its
  // own "haven't heard back" nudge.
  if (claim.user_id !== callerId) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Service-role read — this is the ONLY place phone/consent fields are read
  // for this flow, and they never leave this function.
  const { data: contractor, error: contractorErr } = await sb
    .from("contractors")
    .select("company_name, phone, notification_phones, sms_opt_in")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    return json({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // Contractor must be linked to the claim via selected_contractor_id or a
  // quote — same authorization shape as get-contractor-info, so a homeowner
  // cannot nudge a contractor unrelated to their claim.
  const linkedViaSelected = claim.selected_contractor_id === contractor_id;
  let linkedViaQuote = false;
  if (!linkedViaSelected) {
    const { data: quote } = await sb
      .from("quotes")
      .select("id")
      .eq("claim_id", claim_id)
      .eq("contractor_id", contractor_id)
      .maybeSingle();
    linkedViaQuote = !!quote;
  }

  if (!linkedViaSelected && !linkedViaQuote) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  const contractorName = contractor.company_name || "your contractor";
  const homeownerName = claim.homeowner_name || "your homeowner";
  const address = claim.property_address || "their property";
  const signedDate = claim.contract_signed_at
    ? new Date(claim.contract_signed_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    : "recently";

  const contractorMsg =
    `Otter Quotes: Hi ${contractorName} — your homeowner ${homeownerName} (${address}) signed their contract on ${signedDate} and hasn't heard from you yet. Please reach out as soon as possible. Questions? Call (844) 875-3412.`;
  const dustinMsg =
    `Otter Quotes Alert: ${homeownerName} (claim ${claim_id}) says they haven't heard from ${contractorName} since signing on ${signedDate}. Heads up.`;

  const phones: string[] = [];
  if (Array.isArray(contractor.notification_phones)) {
    for (const p of contractor.notification_phones) {
      if (p && !phones.includes(p)) phones.push(p);
    }
  }
  if (contractor.phone && !phones.includes(contractor.phone)) {
    phones.push(contractor.phone);
  }

  // D-328 / gh-1916 R-134 gate: attemptContractorSms refuses (+logs) before
  // ever calling Twilio unless contractor.sms_opt_in is strictly true.
  let contractorNotified = false;
  for (const phone of phones) {
    const result = await attemptContractorSms(
      fetch,
      supabaseUrl,
      serviceRoleKey,
      phone,
      contractorMsg,
      contractor_id,
      contractor.sms_opt_in,
    );
    if (result.ok) contractorNotified = true;
  }

  // Always attempt to alert Dustin — independent of the contractor's consent
  // state; this is not a contractor SMS send and D-328 does not gate it.
  let dustinNotified = false;
  try {
    const dustinResp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ to: DUSTIN_ALERT_PHONE, message: dustinMsg }),
    });
    dustinNotified = dustinResp.ok;
    if (!dustinResp.ok) {
      console.error(
        "[send-contractor-nudge] Dustin alert send-sms failed:",
        dustinResp.status,
        await dustinResp.text(),
      );
    }
  } catch (err) {
    console.error("[send-contractor-nudge] Dustin alert threw:", err);
  }

  // Observability only — never returned to the caller (see below).
  console.log(
    `[send-contractor-nudge] claim ${claim_id} contractor ${contractor_id}: contractorNotified=${contractorNotified} dustinNotified=${dustinNotified}`,
  );

  // Deliberately no phone number, sms_opt_in value, contractorNotified, or
  // any other consent-derived field in this response — even a boolean
  // "was the contractor texted" is a consent signal (it is false whenever
  // sms_opt_in isn't true). The caller learns only that the request was
  // handled, never whether the contractor was actually texted or refused.
  return json({ ok: true }, 200, corsHeaders);
});
