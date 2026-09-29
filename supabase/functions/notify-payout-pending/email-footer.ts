// email-footer.ts (gh-1824 footer batch 4)
//
// The D-237 mailing-address constant, duplicated (not imported) from
// send-homeowner-next-steps/email-footer.ts.
//
// WHY DUPLICATED, NOT IMPORTED: this repo's Edge Function deploy path does
// not resolve imports across function directories -- the same constraint
// documented in send-homeowner-next-steps/email-footer.ts's own header, and
// the reason notify-measurement-order, send-measurement-ready,
// send-partner-onboarding, send-partner-status-email, send-bid-confirmation,
// send-welcome-email, send-message-notification, send-incomplete-onboarding-reminders,
// admin-contractor-action, approve-payout, approve-warranty-drift,
// check-rate-limits, counter-sig-reminders, mark-job-complete, mark-payout-paid,
// notify-admin-new-contractor, notify-contractors, notify-feature-request and
// notify-partner-w9 each carry their own byte-identical copy of this file
// rather than importing one shared module.
//
// Value: the resolved D-237 answer (comment 5583808162, 2026-09-08 on #1824),
// reused here for this function's commercial email surface per the same
// reasoning used for the prior additions -- reusing an already-answered
// legal string for a new commercial-email surface is not itself a new
// Tier C legal question.
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
