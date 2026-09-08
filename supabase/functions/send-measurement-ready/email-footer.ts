/**
 * email-footer.ts (gh-1412 / gh-1824)
 *
 * ONE constant for the physical postal address that every outbound OtterQuote
 * email footer must carry, and the two renderers that place it.
 *
 * WHY THIS FILE EXISTS AND WHY THE VALUE IS A PLACEHOLDER
 * ──────────────────────────────────────────────────────────────────────────
 * Neither of the measurement-order emails (nor the nudge series, nor the
 * referral email) carries a physical postal address today. CAN-SPAM requires
 * a valid physical postal address on every commercial email; purely
 * transactional mail is exempt, and both measurement emails are transactional
 * — an admin fulfilment notice and a paid-order-is-ready notice — so this is
 * not a live violation on these two templates. It is a house-wide gap, raised
 * by the R-177 LEGAL-READ of PR #1810 and filed as #1824, which asks Dustin
 * one question: WHICH address goes in the footer (registered agent, PO box,
 * or the business address on file with Stripe). That is a Tier C legal
 * disclosure choice and no agent may pick it.
 *
 * #1824's own closes-on says: "then a code sub-issue for the CTO adds the
 * footer constant to every outbound template." This is that constant, added
 * ahead of the answer so the answer is a ONE-LINE change:
 *
 *     export const POSTAL_ADDRESS = "{{POSTAL_ADDRESS}}";
 *                                    ^^^^^^^^^^^^^^^^^^ replace this string
 *
 * Until then the literal token `{{POSTAL_ADDRESS}}` renders. That is
 * deliberate and is the safer of the two failure modes: an unresolved
 * placeholder in a footer is visible, greppable and obviously wrong, whereas
 * a guessed address would be a legal disclosure invented by a machine, and
 * silently omitting the line would leave nothing to find. `isPostalAddressResolved()`
 * exists so a future compliance check can assert the token is gone.
 *
 * Colocated per Edge Function directory (not _shared/) because the EF deploy
 * path does not resolve `_shared/` imports — the same constraint documented in
 * `_shared/sentry.ts`, `_shared/email.ts` and this directory's
 * `notification-failure.ts`. This file is byte-identical across
 * notify-measurement-order and send-measurement-ready; keep the copies in
 * sync by eye.
 *
 * WHAT THIS FILE DOES NOT DO
 * ──────────────────────────────────────────────────────────────────────────
 * It does not add an unsubscribe link. These two templates are transactional;
 * adding an opt-out to a paid-order receipt would be wrong, and the nudge
 * series' opt-out is D-320's own mechanism, not this one.
 */

/**
 * The single source of truth. Replace this ONE string with Dustin's answer on
 * #1824 and every footer that imports it is correct.
 */
export const POSTAL_ADDRESS = "{{POSTAL_ADDRESS}}";

/** The unresolved token, exported so tests and compliance checks can name it. */
export const POSTAL_ADDRESS_PLACEHOLDER = "{{POSTAL_ADDRESS}}";

/** True once #1824's answer has replaced the placeholder. */
export function isPostalAddressResolved(): boolean {
  return POSTAL_ADDRESS !== POSTAL_ADDRESS_PLACEHOLDER;
}

/** The footer's postal-address line, plain text. */
export function footerPostalAddressText(): string {
  return POSTAL_ADDRESS;
}

/** The footer's postal-address line, HTML (already escaped-safe: no user input). */
export function footerPostalAddressHtml(): string {
  return `<div style="margin-top:6px;">${POSTAL_ADDRESS}</div>`;
}
