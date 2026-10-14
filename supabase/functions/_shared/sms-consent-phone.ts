// gh-1916 / D-383 (extends D-328; narrows D-131's SMS leg): a contractor text
// goes ONLY to the phone number that was on the account when the contractor
// ticked the SMS consent box (contractors.sms_consent_phone), never to
// notification_phones added later in Settings and never to the profile phone.
// TCPA consent attaches to a number; a number that never saw the consent text
// is not covered.
//
// Pure functions so every contractor send site shares one definition and the
// rule is Deno-testable without a client or a network call.
//
// FAIL CLOSED: a contractor with sms_opt_in = true but no stored
// sms_consent_phone (every row consented before this column existed) gets NO
// recipient. There is no fallback to contractors.phone or notification_phones.

/** Digits-only form used to compare two phone strings. NANP: a leading 1 on 11 digits is dropped. */
export function phoneDigits(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** E.164 (+1XXXXXXXXXX) form of the consented phone, or null when absent/invalid. */
export function consentedSmsPhone(
  contractor: { sms_consent_phone?: unknown } | null | undefined,
): string | null {
  const d = phoneDigits(contractor?.sms_consent_phone);
  return d ? `+1${d}` : null;
}

/**
 * The only recipients a contractor SMS may be sent to: `[consentedPhone]` or `[]`. Call sites do not
 * pass notification_phones or the profile phone any more; a later-added number is never a recipient.
 */
export function consentedSmsRecipients(
  contractor: { sms_consent_phone?: unknown } | null | undefined,
): string[] {
  const consented = consentedSmsPhone(contractor);
  return consented ? [consented] : [];
}
