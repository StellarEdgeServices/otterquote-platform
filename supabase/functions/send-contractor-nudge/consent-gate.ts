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
export const CURRENT_CONTRACTOR_SMS_CONSENT_VERSION = "contractor-v2-2026-09-15";

/**
 * The send-path gate itself: true only when consent is really, strictly
 * `true` AND the stored consent was captured under the CURRENT text version.
 * NULL/undefined `smsOptIn` (never asked — the v115 default for every
 * pre-migration row) and `false` (opted out) both refuse, as do a missing or
 * superseded `smsConsentTextVersion` even when `smsOptIn` is `true` — the
 * contractor agreed to a sentence Otter Quotes no longer sends under.
 */
export function isSmsConsented(
  smsOptIn: boolean | null | undefined,
  smsConsentTextVersion: string | null | undefined,
): boolean {
  return smsOptIn === true && smsConsentTextVersion === CURRENT_CONTRACTOR_SMS_CONSENT_VERSION;
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
 * as an internal caller — see send-sms/index.ts). Refuses BEFORE any network
 * call unless `smsOptIn` is strictly `true` AND `smsConsentTextVersion`
 * equals `CURRENT_CONTRACTOR_SMS_CONSENT_VERSION`. `fetchImpl` is injected so
 * this is unit-testable without a live network call or a real Supabase
 * project — the test asserts fetchImpl is never called for a non-consenting
 * (or stale-version) contractor and IS called for a genuinely, currently
 * consenting one.
 */
export async function attemptContractorSms(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  to: string,
  message: string,
  contractorId: string,
  smsOptIn: boolean | null | undefined,
  smsConsentTextVersion: string | null | undefined,
): Promise<SendResult> {
  if (!isSmsConsented(smsOptIn, smsConsentTextVersion)) {
    console.warn(
      `[send-contractor-nudge] SMS refused (gh-1916 R-134 / D-328 gate) — sms_opt_in/sms_consent_text_version do not satisfy the gate for contractor ${contractorId} (sms_opt_in=${String(smsOptIn)}, sms_consent_text_version=${String(smsConsentTextVersion)}, required=${CURRENT_CONTRACTOR_SMS_CONSENT_VERSION}). No Twilio call attempted.`,
    );
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
