// gh-1916 CLOSE-REVIEW FAIL 5777750121 — pure shaping logic split out of index.ts
// so it is Deno-testable without a live Supabase client (same source-split
// pattern as approve-payout/w9-gate.ts, mint-test-session/gate.ts).
//
// The send path (notify-contractors, process-dunning, the homeowner "nudge" in
// contract-signing.html / its React port) gates strictly on `sms_opt_in === true`.
// Unknown or null must mean NO SEND. This module is the single place that turns
// a raw contractors row into the consent fields get-contractor-info returns, so
// that gate can never see anything but `true` or `null` for sms_opt_in — never a
// bare `false`, a stray string, or a truthy-but-not-boolean value — and so the
// opt-in metadata (timestamp, consent text version) never leaks when consent
// isn't actually `true`.

export interface ContractorConsentRow {
  phone?: string | null;
  notification_phones?: string[] | null;
  sms_opt_in?: boolean | null;
  sms_opt_in_at?: string | null;
  sms_consent_text_version?: string | null;
}

export interface ContractorConsentFields {
  phone: string | null;
  notification_phones: string[] | null;
  sms_opt_in: true | null;
  sms_opt_in_at: string | null;
  sms_consent_text_version: string | null;
}

/**
 * Narrow a raw contractors row to the consent + phone fields get-contractor-info
 * returns. `sms_opt_in` collapses to exactly `true` or `null` — never `false` —
 * matching contractors.sms_opt_in's own NULL-until-consented contract (v115).
 * The opt-in timestamp and consent-text-version are withheld unless sms_opt_in
 * is really `true`, so a caller can never see "which text version" metadata for
 * a contractor who has not actually consented.
 */
export function shapeConsentFields(row: ContractorConsentRow): ContractorConsentFields {
  const optedIn = row.sms_opt_in === true;
  return {
    phone: row.phone ?? null,
    notification_phones: row.notification_phones ?? null,
    sms_opt_in: optedIn ? true : null,
    sms_opt_in_at: optedIn ? row.sms_opt_in_at ?? null : null,
    sms_consent_text_version: optedIn ? row.sms_consent_text_version ?? null : null,
  };
}

/**
 * The send-path gate itself (gh-1916 R-134): true only when consent is really,
 * strictly `true`. Exported so the gate and its tests share one implementation
 * instead of every consumer re-deriving `=== true` by hand.
 */
export function isSmsConsented(smsOptIn: boolean | null | undefined): boolean {
  return smsOptIn === true;
}
