/**
 * email-footer.ts (gh-1944)
 *
 * ONE constant for the physical postal address this function's footer must
 * carry, and the two renderers that place it.
 *
 * WHY THIS COPY EXISTS, AND WHY IT DIFFERS FROM THE OTHER TWO
 * ──────────────────────────────────────────────────────────────────────────
 * `send-measurement-ready` and `notify-measurement-order` carry a
 * byte-identical `email-footer.ts` because both of their emails are
 * TRANSACTIONAL (an admin fulfilment notice, a paid-order-is-ready notice)
 * and CAN-SPAM's physical-address requirement is written for COMMERCIAL
 * email — so on those two templates the address is good practice, not a
 * legal requirement. `send-homeowner-next-steps` is different: its copy
 * ("You're one step from bids — order or upload your roof measurements...")
 * is the Tier B *promotional nudge* gh-1580 built, not a receipt or a status
 * update. CAN-SPAM's address requirement DOES apply to it, and gh-1944 is
 * the issue that noticed this template had no `email-footer.ts` at all.
 *
 * The value below is NOT a fresh Tier C legal decision — it is the SAME
 * D-237 mailbox address Dustin already ruled on for #1824 (comment
 * 5583808162, 2026-09-08T10:35:53Z). Reusing an already-answered legal
 * string for a new commercial-email surface is not itself a new legal
 * question; it would only become one if a DIFFERENT address were proposed.
 *
 *     export const POSTAL_ADDRESS = "...";
 *                                    ^^ the resolved D-237 answer, verbatim
 *
 * Colocated per Edge Function directory (not `_shared/`), same constraint as
 * the other two copies: this repo's Edge Function deploy path does not
 * resolve `_shared/` imports.
 *
 * WHAT THIS FILE DOES NOT DO
 * ──────────────────────────────────────────────────────────────────────────
 * It does not add or change the opt-out link — that is D-320's mechanism
 * (`./optout-token.ts`, `OPTOUT_TEXT_LINE` / `OPTOUT_LINK_TEXT` in
 * `./email-content.ts`) and is unrelated to the postal-address requirement.
 * Both lines appear in the footer; neither one satisfies the other.
 */

/** The D-237 mailbox address, same resolved value as #1824. */
export const POSTAL_ADDRESS: string =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

/**
 * Kept only as a named export so a compliance sweep can assert this exact
 * string never appears in a rendered email — mirrors the other two copies.
 */
export const POSTAL_ADDRESS_PLACEHOLDER = "{{POSTAL_ADDRESS}}";

/** True once the constant above holds a real (non-empty) address. */
export function isPostalAddressResolved(): boolean {
  return POSTAL_ADDRESS !== "";
}

/** The footer's postal-address line, plain text. */
export function footerPostalAddressText(): string {
  return POSTAL_ADDRESS;
}

/**
 * The footer's postal-address line, HTML (already escaped-safe: no user
 * input). Emits NO element at all if the constant were ever empty — the
 * caller gets "" to concatenate, not an empty-but-present `<div>`.
 */
export function footerPostalAddressHtml(): string {
  if (POSTAL_ADDRESS === "") return "";
  return `<div style="margin-top:6px;">${POSTAL_ADDRESS}</div>`;
}
