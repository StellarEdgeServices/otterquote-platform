/**
 * templates.ts — pure template builders for the 5-stage partner referral
 * status email series (#856).
 *
 * Kept separate from index.ts (no network/DB calls in this file) so the
 * five templates can be rendered and asserted on directly in
 * templates.test.ts, matching the docusign-webhook/payload-parser.ts and
 * notify-contractors/test-exclusion.ts precedent of splitting pure logic
 * out of the HTTP handler for testability.
 *
 * ── #869 compliance ────────────────────────────────────────────────────
 * Every email built here sends BOTH an html and a text part, and every URL
 * in the html part is rendered as a button or an inline link — never bare.
 * The plain-text part deliberately keeps the bare URL (#869 AC 2).
 *
 * emailButton / emailLink / textCta below are INLINED copies of the
 * canonical definitions in `supabase/functions/_shared/email.ts`. See that
 * file's header comment for why they are duplicated rather than imported
 * (the EF body-deploy path does not resolve `_shared/` imports — established
 * precedent elsewhere in this codebase).
 *
 * ── Privacy (#856 AC) ──────────────────────────────────────────────────
 * #856's AC requires a privacy decision be made and documented before
 * templates are built: how much of a referral's claim does the partner get
 * to see? No CEO ruling exists in the issue thread beyond the issue's own
 * stated recommendation, so this build follows that recommendation exactly:
 * name the referral (first name + last-initial only — see
 * formatReferralDisplayName below) and the stage only. NO dollar amounts,
 * NO contractor name, NO scope/damage detail anywhere in any of the 5
 * templates. This is flagged as a QUESTION in the task report — treat the
 * privacy scope as provisional until Dustin confirms or overrides it.
 *
 * ── No payout timing (#850 class guard) ───────────────────────────────
 * Stage 5 is the only template that mentions payment. Per #856's explicit
 * instruction it says payment is on its way and states NO interval. None
 * of these five templates contain the words "commission"/"payout"/
 * "disburs*" paired with a duration — verified by running
 * scripts/check-payout-timing-copy-drift.py against this file (see the
 * task report for the run output).
 */

const BRAND_AMBER = "#E07B00";
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const PARTNER_DASHBOARD_URL = "https://otterquote.com/partner-dashboard.html";

export interface EmailCtaInput {
  href: string;
  label: string;
}

// ── Inlined from _shared/email.ts (#869) — see header comment above ──────

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

export function emailLink({ href, label }: EmailCtaInput): string {
  return `<a href="${href}" style="color:#0EA5E9;text-decoration:underline;">${label}</a>`;
}

export function textCta({ href, label }: EmailCtaInput): string {
  return `${label}: ${href}`;
}

// ── Privacy-safe name formatting ──────────────────────────────────────────

/**
 * "Jane Doe" -> "Jane D."   "Jane" -> "Jane"   null/"" -> "your referral"
 * Deliberately drops the surname to limit disclosure to the partner per the
 * privacy scope documented above.
 */
export function formatReferralDisplayName(
  homeownerName: string | null | undefined,
): string {
  const trimmed = (homeownerName || "").trim();
  if (!trimmed) return "your referral";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}.`;
}

// ── Email shell (mirrors notify-partner-w9 / notify-payout-pending) ──────

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:${FONT_STACK};font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
    </td>
  </tr>
</table>`.trim();
}

function buildEmailShell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:${FONT_STACK};font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:${FONT_STACK};">
            ${bodyHtml}
          </td>
        </tr>
        <tr><td>${emailFooter()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

// ── Stage definitions ─────────────────────────────────────────────────────

export type Stage = 1 | 2 | 3 | 4 | 5;

export const STAGE_KEYS: Record<Stage, string> = {
  1: "claim_submitted",
  2: "bid_received",
  3: "bid_accepted",
  4: "contract_signed",
  5: "job_completed",
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders one of the 5 stage emails. `displayName` should already be run
 * through formatReferralDisplayName (kept as a separate step so tests can
 * exercise both functions independently).
 */
export function renderStageEmail(stage: Stage, displayName: string): RenderedEmail {
  const cta = { href: PARTNER_DASHBOARD_URL, label: "View My Dashboard" };
  const htmlCta = emailButton(cta);
  const textCtaLine = textCta(cta);

  switch (stage) {
    case 1:
      return {
        subject: `Update on your Otter Quotes referral, ${displayName}`,
        html: buildEmailShell(`
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Referral Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your referral started the process</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Good news — <strong>${displayName}</strong>, the person you referred, has started their project with Otter Quotes.</p>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">We'll keep you posted as things move along. No action is needed from you right now.</p>
    ${htmlCta}
        `),
        text: [
          `Referral Update: Your referral started the process`,
          ``,
          `Good news — ${displayName}, the person you referred, has started their project with Otter Quotes.`,
          `We'll keep you posted as things move along. No action is needed from you right now.`,
          ``,
          textCtaLine,
        ].join("\n"),
      };

    case 2:
      return {
        subject: `Update: ${displayName}'s project is out for bids`,
        html: buildEmailShell(`
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Referral Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your referral submitted for bids</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;"><strong>${displayName}</strong>'s project is now open, and contractors are submitting bids.</p>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">We'll let you know as soon as they pick someone.</p>
    ${htmlCta}
        `),
        text: [
          `Referral Update: Your referral submitted for bids`,
          ``,
          `${displayName}'s project is now open, and contractors are submitting bids.`,
          `We'll let you know as soon as they pick someone.`,
          ``,
          textCtaLine,
        ].join("\n"),
      };

    case 3:
      return {
        subject: `Update: ${displayName} picked a contractor`,
        html: buildEmailShell(`
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Referral Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your referral picked a contractor</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;"><strong>${displayName}</strong> has picked a contractor for their project.</p>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Next up is getting their agreement signed — we'll let you know when that happens.</p>
    ${htmlCta}
        `),
        text: [
          `Referral Update: Your referral picked a contractor`,
          ``,
          `${displayName} has picked a contractor for their project.`,
          `Next up is getting their agreement signed — we'll let you know when that happens.`,
          ``,
          textCtaLine,
        ].join("\n"),
      };

    case 4:
      return {
        subject: `Update: ${displayName} signed their agreement`,
        html: buildEmailShell(`
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Referral Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your referral signed an agreement</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;"><strong>${displayName}</strong> has signed their agreement, and their project is officially underway.</p>
    ${htmlCta}
        `),
        text: [
          `Referral Update: Your referral signed an agreement`,
          ``,
          `${displayName} has signed their agreement, and their project is officially underway.`,
          ``,
          textCtaLine,
        ].join("\n"),
      };

    case 5:
      return {
        subject: `Update: ${displayName}'s job is complete`,
        html: buildEmailShell(`
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Referral Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your referral's job is done — payment is on its way</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;"><strong>${displayName}</strong>'s job has been marked complete.</p>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Payment for this referral is on its way. No action is needed from you.</p>
    ${htmlCta}
        `),
        text: [
          `Referral Update: Your referral's job is done — payment is on its way`,
          ``,
          `${displayName}'s job has been marked complete.`,
          `Payment for this referral is on its way. No action is needed from you.`,
          ``,
          textCtaLine,
        ].join("\n"),
      };
  }
}
