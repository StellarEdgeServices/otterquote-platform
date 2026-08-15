/**
 * email.ts — shared outbound-email primitives (#869).
 *
 * #869 audit: button markup was hand-rolled 5 separate times in 3 different
 * colors across the Edge Functions, with no shared helper anywhere in
 * `supabase/functions/_shared/`. This file is the canonical, single-source
 * definition of the three primitives #869 calls for:
 *
 *   - emailButton({ href, label })  — table-based CTA + MSO VML conditional
 *     so Outlook renders a real filled rectangle, not a bare link. Brand
 *     amber #E07B00.
 *   - emailLink({ href, label })    — inline in-sentence anchor.
 *   - textCta({ href, label })      — plain-text-part equivalent. Per #869
 *     AC 2, the text/plain part KEEPS the bare URL deliberately — that is
 *     the accessibility fallback and the fallback for clients with HTML
 *     blocked. Do not "fix" it.
 *
 * ── IMPORTANT: consumers must INLINE these, not import them ──────────────
 * The EF body-deploy path in this repo does not resolve `_shared/` imports
 * (established precedent: `send-bid-confirmation/index.ts` and
 * `docusign-webhook/index.ts` both inline their own copy of a Sentry
 * reporter for the same reason; `_shared/getHomeownerName.ts` is the same
 * pattern one level up — `create-docusign-envelope` inlines its own copy
 * rather than importing it). This file exists so every button implementation
 * in the codebase can be diffed against ONE source of truth and kept in
 * sync by eye, not so it can be `import`-ed directly into a deployed
 * function. If the deploy path is ever changed to bundle `_shared/`, these
 * exports can become real imports with no signature change.
 *
 * Full #869 migration of the 5 existing duplicated button implementations
 * (notify-contractors, notify-partner-w9, process-payout-reminders,
 * notify-payout-pending, send-home-profile-prompt) is NOT done by this file
 * alone — that is #869's own scope and touches files outside this issue's
 * (#856) whitelist. This file only supplies the canonical definition that
 * both #869's future migration and #856's new partner-status-email function
 * inline from.
 */

const BRAND_AMBER = "#E07B00";
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

export interface EmailCtaInput {
  href: string;
  label: string;
}

/**
 * Table-based CTA button with an MSO VML conditional fallback so Outlook
 * (desktop, which ignores CSS border-radius/background on <a> tags) renders
 * a real filled, rounded rectangle instead of a bare underlined link.
 */
export function emailButton({ href, label }: EmailCtaInput): string {
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="${BRAND_AMBER}" fillcolor="${BRAND_AMBER}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:${FONT_STACK};font-size:16px;font-weight:700;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND_AMBER}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${label}</a>
    </td>
  </tr>
</table>
<!--<![endif]-->`.trim();
}

/** Inline in-sentence anchor — for links that sit inside a paragraph. */
export function emailLink({ href, label }: EmailCtaInput): string {
  return `<a href="${href}" style="color:#0EA5E9;text-decoration:underline;">${label}</a>`;
}

/**
 * Plain-text-part equivalent. Per #869 AC 2, this deliberately keeps the
 * bare URL — text/plain clients cannot render a styled link, and this is
 * the accessibility + HTML-blocked fallback. Never strip the URL here.
 */
export function textCta({ href, label }: EmailCtaInput): string {
  return `${label}: ${href}`;
}
