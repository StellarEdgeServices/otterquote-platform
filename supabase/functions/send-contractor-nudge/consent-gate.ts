// gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44, fresh-context REVIEW+LEGAL-READ
// FAIL 5856738126 on PR #2252) — pure gating logic split out of index.ts so it
// is Deno-testable without a live Supabase client or network call (same
// source-split pattern as get-contractor-info's retired consent-shape.ts,
// approve-payout/w9-gate.ts, mint-test-session/gate.ts).
//
// D-328: "No contractor SMS send path may fire without contractors.sms_opt_in
// = true ... Applies to notify-contractors, process-dunning, the
// contract-signing 'haven't heard from your contractor' nudge ... and any
// future sender." This module is that gate for the nudge sender. Unknown
// (null/undefined) or a stored opt-OUT (false) both refuse — only a strict
// `true` may ever reach Twilio. Mirrors notify-contractors'
// sendSmsViaEdgeFunction (supabase/functions/notify-contractors/index.ts)
// exactly, so the same choke point exists for every SMS-sending function.
//
// RETURNED 5856782745 (Marty, CTO RUN 44) fix 2 (coordinator follow-up on
// PR #2252): `sms_opt_in = true` alone is not the whole of D-328's "opted in,
// current text version contractor-v2-2026-09-15" condition. A contractor who
// consented under a since-superseded sentence (`contractor-v1-2026-09-14`,
// the pre-CEO-RUN-43 draft — see contractor-join.html's own
// sms_consent_text_version write) or with no stored version at all must
// still be refused. CURRENT_CONTRACTOR_SMS_CONSENT_VERSION is the ONE place
// that string lives on this send path — contractor-join.html (the #1938
// consent-capture form, untouched by this fix) has its own literal for the
// same reason contractor-join.html and this Edge Function cannot share a
// TS module (one is a static page, the other a Deno function); grepping the
// repo for the literal found no existing shared constant to import instead.
import { type ContractorSmsGateOptions, contractorSmsReleaseGate } from "../_shared/contractor-sms-release.ts"; // D-391 / #2875 TCR release gate
import { resolveContractorTextableNumbers, type TextableClient } from "../_shared/contractor-textable.ts"; // D-391 / #2875 layer 4

// D-391 / #2875 layer 4 SUPERSEDES the D-328 gate described above: the sms_opt_in + consent-text-version test
// (isSmsConsented, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION) is gone. The unit of consent is now the one-time-code-
// verified NUMBER, so the nudge texts only the numbers returned by contractor_textable_numbers() and never
// contractors.phone / notification_phones / sms_opt_in. A contractor with no verified number is not texted and the
// skip is logged as `unverified_number`.

/**
 * The numbers the nudge may text for this contractor. The is_test / TCR release gate sits IN FRONT of the lookup (a
 * contractor who may not be texted at all costs no query); then only contractor_textable_numbers() rows are returned.
 * Empty = send nothing (a refusal has been logged).
 */
export async function resolveNudgeRecipients(
  sb: TextableClient,
  contractorId: string,
  isTest: boolean | null | undefined,
  gateOpts?: Pick<ContractorSmsGateOptions, "getEnv" | "log">,
): Promise<string[]> {
  const site = "send-contractor-nudge/consent-gate";
  if (!contractorSmsReleaseGate({ id: contractorId, is_test: isTest }, { site, ...gateOpts }).allowed) {
    return [];
  }
  const recipients = await resolveContractorTextableNumbers(sb, contractorId, { site, log: gateOpts?.log });
  return recipients.map((r) => r.phone);
}

export interface SendResult {
  /** Whether a call to send-sms was actually made. false → refused by the gate; no Twilio call attempted. */
  attempted: boolean;
  /** Whether send-sms reported success. Only meaningful when attempted is true. */
  ok: boolean;
}

/**
 * Attempt a single contractor SMS via the send-sms Edge Function, using the
 * service-role bearer (send-sms's own auth gate trusts the service-role key
 * as an internal caller — see send-sms/index.ts). `to` must be a number from
 * resolveNudgeRecipients(). Refuses BEFORE any network call unless (D-391 /
 * #2875) the contractor is_test or the CONTRACTOR_SMS_TCR_RELEASED switch is
 * "true". `fetchImpl` is injected so this is unit-testable without a live
 * network call or a real Supabase project.
 */
export async function attemptContractorSms(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  to: string,
  message: string,
  contractorId: string,
  // D-391 / #2875: contractors.is_test. Required (no default) so a caller that forgets it fails closed:
  // undefined/null is "not a test contractor", refused until CONTRACTOR_SMS_TCR_RELEASED === "true".
  isTest: boolean | null | undefined,
  gateOpts?: Pick<ContractorSmsGateOptions, "getEnv" | "log">,
): Promise<SendResult> {
  // D-391 / #2875: until the TCR message_flow read-back is pasted, only is_test contractors are texted.
  if (
    !contractorSmsReleaseGate(
      { id: contractorId, is_test: isTest },
      { site: "send-contractor-nudge/consent-gate", phones: [to], ...gateOpts },
    ).allowed
  ) {
    return { attempted: false, ok: false };
  }

  const response = await fetchImpl(`${supabaseUrl}/functions/v1/send-sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
    },
    body: JSON.stringify({ to, message }),
  });

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch {
      // best-effort only
    }
    console.error(
      `[send-contractor-nudge] send-sms error for contractor ${contractorId}:`,
      response.status,
      errText,
    );
    return { attempted: true, ok: false };
  }

  return { attempted: true, ok: true };
}
