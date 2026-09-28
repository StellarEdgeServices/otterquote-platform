// gh-2154 P-5r — the D-237 mailing-address constant, duplicated (not
// imported) from send-partner-onboarding/email-footer.ts (itself duplicated
// from send-homeowner-next-steps/email-footer.ts).
//
// WHY DUPLICATED, NOT IMPORTED: this repo's Edge Function deploy path does
// not resolve imports across function directories — see
// send-homeowner-next-steps/email-footer.ts's own header for the standing
// precedent. email-footer.test.ts in this directory asserts this constant
// is byte-identical to send-partner-onboarding's own copy.
//
// Value: the resolved D-237 answer (comment 5583808162, 2026-09-08), reused
// verbatim for this invite email's footer — not a fresh Tier C legal
// decision.

/** The D-237 mailbox address — must stay byte-identical to
 * send-partner-onboarding/email-footer.ts's POSTAL_ADDRESS (see
 * email-footer.test.ts). */
export const POSTAL_ADDRESS: string =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";
