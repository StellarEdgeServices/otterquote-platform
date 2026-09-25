// email-footer.ts (gh-1824)
//
// The D-237 mailing-address constant, duplicated (not imported) from
// send-homeowner-next-steps/email-footer.ts.
//
// WHY DUPLICATED, NOT IMPORTED: this repo's Edge Function deploy path does
// not resolve imports across function directories -- the same constraint
// documented in send-homeowner-next-steps/email-footer.ts's own header, and
// the reason notify-measurement-order, send-measurement-ready and
// send-partner-onboarding each carry their own byte-identical copy of this
// file rather than importing one shared module.
//
// Value: the resolved D-237 answer (comment 5583808162, 2026-09-08 on #1824;
// reused for #1944's homeowner-nudge footer, for #2154's partner-onboarding
// footer, and now reused again here for the #856 partner referral-status
// series per the same reasoning -- reusing an already-answered legal string
// for a new commercial-email surface is not itself a new Tier C legal
// question).
//
// Colocated per Edge Function directory (not _shared/) -- see
// `_shared/email.ts` and `notify-measurement-order/email-footer.ts` headers.

/** The D-237 mailbox address -- must stay byte-identical to
 * send-homeowner-next-steps/email-footer.ts's POSTAL_ADDRESS (see
 * email-footer.test.ts). */
export const POSTAL_ADDRESS: string =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

/** True once the address has been filled in (kept for parity with the other
 * email-footer.ts copies' isPostalAddressResolved() so a future compliance
 * sweep can assert this consistently across every function). */
export function isPostalAddressResolved(): boolean {
  return POSTAL_ADDRESS !== "";
}

/** The footer's postal-address line, plain text. */
export function footerPostalAddressText(): string {
  return POSTAL_ADDRESS;
}

/** The footer's postal-address line, HTML (no user input, safe to inline). */
export function footerPostalAddressHtml(): string {
  if (POSTAL_ADDRESS === "") return "";
  return `<div style="margin-top:6px;">${POSTAL_ADDRESS}</div>`;
}
