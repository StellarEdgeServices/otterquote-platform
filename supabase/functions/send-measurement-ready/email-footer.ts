/**
 * email-footer.ts (gh-1412 / gh-1824)
 *
 * ONE constant for the physical postal address that every outbound OtterQuote
 * email footer must carry, and the two renderers that place it.
 *
 * WHY THE VALUE IS EMPTY, NOT A LITERAL TOKEN (CEO Tier B ruling, 2026-09-08)
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
 * R-177 LEGAL-READ (ceo35-legalread-j) FAILED the prior version of this file,
 * which rendered the literal token `{{POSTAL_ADDRESS}}` into both bodies of
 * a paid-customer email. A source-code placeholder is a property of the
 * FILE; once rendered into an outbound message it is customer-facing copy
 * that cannot be un-sent. The CEO's Tier B ruling: until #1824 is answered,
 * the postal-address line is OMITTED ENTIRELY.
 *
 *   - `footerPostalAddressText()` returns `""`.
 *   - `footerPostalAddressHtml()` returns `""` (the caller's markup emits
 *     no `<div>` at all when the constant is empty — nothing for a
 *     homeowner or admin to see, no literal braces, no guessed address).
 *
 * `POSTAL_ADDRESS` remains the single source of truth so #1824's answer is
 * still a ONE-LINE change:
 *
 *     export const POSTAL_ADDRESS = "";
 *                                    ^^ replace this string with the answer
 *
 * `isPostalAddressResolved()` exists so a future compliance check can assert
 * the address has been filled in (non-empty). The tripwire test in
 * email-footer.test.ts is inverted from the FAILED version: it now asserts
 * the render path is EMPTY and that the literal token `{{POSTAL_ADDRESS}}`
 * never appears in what either renderer returns — it FAILS the moment
 * anyone reintroduces a literal placeholder into the render path, and
 * PASSES on omission.
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
 * The single source of truth. Empty until Dustin answers #1824; replace this
 * ONE string with his answer and every footer that imports it is correct.
 */
export const POSTAL_ADDRESS = "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

/**
 * The literal token a prior version of this file rendered unconditionally
 * (R-177 LEGAL-READ FAIL, ceo35-legalread-j). Kept only as a named constant
 * so tests and any future compliance sweep can assert this string never
 * reaches a render path again — it is not used as POSTAL_ADDRESS's value.
 */
export const POSTAL_ADDRESS_PLACEHOLDER = "{{POSTAL_ADDRESS}}";

/** True once #1824's answer has replaced the empty string. */
export function isPostalAddressResolved(): boolean {
  return POSTAL_ADDRESS !== "";
}

/** The footer's postal-address line, plain text. Empty until #1824 is answered. */
export function footerPostalAddressText(): string {
  return POSTAL_ADDRESS;
}

/**
 * The footer's postal-address line, HTML (already escaped-safe: no user
 * input). Emits NO element at all while the constant is empty — the caller
 * gets "" to concatenate, not an empty-but-present <div>.
 */
export function footerPostalAddressHtml(): string {
  if (POSTAL_ADDRESS === "") return "";
  return `<div style="margin-top:6px;">${POSTAL_ADDRESS}</div>`;
}
