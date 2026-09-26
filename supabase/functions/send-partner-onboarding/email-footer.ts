// gh-2154 P-4 — the D-237 mailing-address constant, duplicated (not
// imported) from send-homeowner-next-steps/email-footer.ts.
//
// WHY DUPLICATED, NOT IMPORTED: this repo's Edge Function deploy path does
// not resolve imports across function directories — the same constraint
// documented in send-homeowner-next-steps/email-footer.ts's own header, and
// already the reason send-measurement-ready and notify-measurement-order
// each carry their own copy of this file, and the reason
// send-partner-onboarding/bot-pattern.ts and optout.ts are duplicated
// rather than shared. `email-footer.test.ts` in this directory asserts this
// constant is byte-identical to send-homeowner-next-steps' own — that
// cross-directory import is safe in a *test* file (deno test resolves
// relative imports against the real filesystem; it is only the Supabase EF
// deploy bundler that cannot follow them), so drift is caught even though
// production code never takes the cross-directory dependency.
//
// Value: the resolved D-237 answer (comment 5583808162, 2026-09-08,
// reused for #1944's homeowner-nudge footer, and now reused again here per
// Ben's ruling on #2154 comment 5825271438 — "P-4 uses that constant; the
// [MAILING ADDRESS — NOT FOUND ON DISK] placeholder in 5821400303 is
// replaced by it"). Not a fresh Tier C legal decision: reusing an
// already-answered legal string for a new commercial-email surface is not
// itself a new legal question.

/** The D-237 mailbox address — must stay byte-identical to
 * send-homeowner-next-steps/email-footer.ts's POSTAL_ADDRESS (see
 * email-footer.test.ts). */
export const POSTAL_ADDRESS: string =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";
