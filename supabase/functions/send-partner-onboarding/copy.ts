// gh-2154 P-4 — partner onboarding email copy.
//
// Copy is Tier C (Sloane proposes, Dustin approves) — the words below are
// NOT invented here. Every subject/preheader/body/CTA is transcribed
// VERBATIM from the DUSTIN-APPROVED source:
//   - Proposed copy: issue #2154 comment 5821400303 (Sloane, CEO RUN 67).
//   - Footer-address ruling: issue #2154 comment 5825271438 (Ben) — the
//     footer's mailing-address line is D-237's POSTAL_ADDRESS constant
//     (./email-footer.ts), replacing 5821400303's
//     "[MAILING ADDRESS — NOT FOUND ON DISK]" gap.
//   - Approval: issue #2154 comment 5832299333 (Dustin, via Ben) —
//     "APPROVED... Approved as posted, with two adjustments. The footer
//     address is D-237's POSTAL_ADDRESS..., replacing the placeholder. Day 7
//     keeps 'last automated reminder'."
// No word of the subject/body/CTA copy below was written by this build —
// only the HTML/plain-text scaffolding (paragraph breaks, the CTA button
// markup, the hidden preheader span) and the token-substitution mechanics
// (`{{first_name}}`, `{{optOutUrl}}`) are new, mirroring
// send-homeowner-next-steps/email-content.ts's own split between "locked
// copy" and "rendering scaffolding".
//
// This is the ONLY place copy lives for this function. index.ts must never
// inline copy — that was the whole point of gh-1786's identical move for
// the homeowner function (see send-homeowner-next-steps/email-content.ts).

import type { EligibleAgentType, OnboardingStage } from "./onboarding-stage.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

export interface EmailCopy {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/** Any field containing this substring is placeholder copy, never sendable.
 * Kept even though real copy has landed: hasPlaceholderCopy() below still
 * runs on every composed message as a mechanical safety net (e.g. against a
 * future stage/agent_type added to the table without copy). */
export const PLACEHOLDER_MARKER = "[[";

// ── 5821400303 "Shared mechanics" — static (non-per-partner) destinations ──
//
// [INSTALL_APP_URL] -> "the install-the-app deep link (same destination as
// the dashboard's 'Install the App' button, partner-dashboard.html /
// /partner-app.html)" -- partner-dashboard.html's own installAppBtn/"How to
// install" link both point at /partner-app.html.
export const INSTALL_APP_URL = "https://otterquote.com/partner-app.html";
// [PARTNER_APP_SIGNIN_URL] -> "the tokenised start_url sign-in entry point
// (P-2)". No per-partner tokenized sign-in URL exists anywhere in this
// codebase today (grepped; none found) -- P-2 built activation detection
// (app_first_signed_in_launch_at), not a personalized deep link.
// partner-app.html IS the installed app's start_url, so this points there
// directly. Ben SHOULD (bus 14:01:57Z, REVIEW FAIL 5833587935): the
// ?source=pwa query param this URL used to carry is unused -- nothing in
// partner-app.html or partner-dashboard.html reads a `source` param (grepped;
// no match) -- so it is dropped. This is a URL-mechanics change, not a copy
// change: no visible word a recipient reads (the CTA button text, the
// subject, the body) is affected, only the href target's query string.
export const PARTNER_APP_SIGNIN_URL = "https://otterquote.com/partner-app.html";

/** `{{first_name}}` merge field, substituted by composeFinalCopy. */
export const FIRST_NAME_TOKEN = "{{first_name}}";

interface StageCopySource {
  subject: string;
  preheader: string;
  /** Body paragraphs, verbatim from 5821400303, in order. Markdown `**bold**`
   * markers are structural notation (this build renders the bolded phrase as
   * HTML `<strong>`), not literal characters the reader sees — the WORDS are
   * unchanged either way. */
  paragraphs: string[];
  ctaText: string;
  ctaUrl: string;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders one markdown-bold-annotated paragraph (`**word**`) to an HTML
 * paragraph, escaping everything else. The `**...**` runs are the ONLY HTML
 * markup source-injected into copy; there is no partner-supplied data in
 * these paragraphs (that only enters via composeFinalCopy's optOutUrl/
 * first_name substitution, escaped there instead). */
function paragraphToHtml(paragraph: string): string {
  const parts = paragraph.split(/(\*\*[^*]+\*\*)/g);
  const html = parts
    .map((part) => {
      const m = part.match(/^\*\*([^*]+)\*\*$/);
      return m ? `<strong>${escapeHtml(m[1])}</strong>` : escapeHtml(part);
    })
    .join("");
  return `<p style="margin:0 0 1rem;line-height:1.6;">${html}</p>`;
}

function paragraphToText(paragraph: string): string {
  return paragraph.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function renderStageCopy(source: StageCopySource): EmailCopy {
  const textParagraphs = source.paragraphs.map(paragraphToText);
  const textBody = [...textParagraphs, `${source.ctaText}: ${source.ctaUrl}`].join("\n\n");

  const htmlParagraphs = source.paragraphs.map(paragraphToHtml).join("");
  const htmlBody =
    // Hidden preheader (standard preview-text pattern): not part of the
    // visible body, never rendered by a client that ignores the style, and
    // never appears in the plain-text alternative -- same reasoning
    // send-homeowner-next-steps applies to its own HTML-only scaffolding.
    `<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(source.preheader)}</span>` +
    htmlParagraphs +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 1rem;"><tr><td style="background:#E07B00;border-radius:8px;padding:14px 28px;"><a href="${source.ctaUrl}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">${escapeHtml(source.ctaText)}</a></td></tr></table>`;

  return { subject: source.subject, textBody, htmlBody };
}

// ─── Approved copy (5821400303, footer/address per 5825271438, APPROVED per
// 5832299333) ────────────────────────────────────────────────────────────

const RE_AGENT_DAY0: StageCopySource = {
  subject: "Your Otter Quotes partner account is ready",
  preheader: "Install the app, then sign in inside it — that's what turns your account on.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN},`,
    "You're set up as an Otter Quotes referral partner. Two steps to get your referral link live:",
    '1. **Install the app.** iPhone: open this email on your phone, tap the button below, then in Safari tap the Share icon and choose **Add to Home Screen**. Android: tap "Install app" when prompted.',
    "2. **Open the app icon from your home screen and sign in there.** The installed app starts signed out, even if you're already signed in in your browser — signing in inside the app is what activates your account and unlocks your referral link.",
    "$200 referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Install the App",
  ctaUrl: INSTALL_APP_URL,
};

const RE_AGENT_DAY1: StageCopySource = {
  subject: "One step left: sign in inside the app",
  preheader: "Installed it yesterday? Open it and sign in — that's the step that activates your account.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, if you installed the Otter Quotes app yesterday, open it from your phone's home screen and sign in there — a fresh sign-in inside the installed app (not your browser) is what activates your referral link.`,
    "Haven't installed it yet? One tap below, then on iPhone: Share icon → Add to Home Screen.",
    "$200 flat referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Open & Sign In",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

const RE_AGENT_DAY3: StageCopySource = {
  subject: "Your referral link is one sign-in away",
  preheader: "Sign in inside the installed app to see your personal link and dashboard.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, your referral link is generated the moment you sign in inside the installed Otter Quotes app — not before. If the app's on your home screen, open it now and sign in. If you haven't installed it yet, start here:`,
  ],
  ctaText: "Install & Sign In",
  ctaUrl: INSTALL_APP_URL,
};

const RE_AGENT_DAY7: StageCopySource = {
  subject: "Last reminder: activate your Otter Quotes account",
  preheader: "Sign in inside the app to get your link — this is the last nudge on this.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, this is the last automated reminder. Sign in inside the installed Otter Quotes app to activate your account and get your referral link — then share it with the first client you have in mind.`,
    "$200 referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Sign In Now",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

const INSURANCE_AGENT_DAY0: StageCopySource = {
  subject: "Your Otter Quotes partner account is ready",
  preheader: "Install the app, then sign in inside it — that's what turns your account on.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN},`,
    "You're set up as an Otter Quotes referral partner. Two steps to get your referral link live:",
    '1. **Install the app.** iPhone: tap the button below, then in Safari tap the Share icon and choose **Add to Home Screen**. Android: tap "Install app" when prompted.',
    "2. **Open the app icon from your home screen and sign in there.** The installed app starts signed out — signing in inside it is what activates your account and unlocks your referral link.",
    "$200 referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Install the App",
  ctaUrl: INSTALL_APP_URL,
};

const INSURANCE_AGENT_DAY1: StageCopySource = {
  subject: "One step left: sign in inside the app",
  preheader: "Installed it yesterday? Open it and sign in — that's the step that activates your account.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, if you installed the Otter Quotes app yesterday, open it from your home screen and sign in — a fresh sign-in inside the installed app is what activates your referral link.`,
    "Haven't installed it yet? One tap below, then on iPhone: Share icon → Add to Home Screen.",
    "$200 flat referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Open & Sign In",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

const INSURANCE_AGENT_DAY3: StageCopySource = {
  subject: "Your referral link is one sign-in away",
  preheader: "Sign in inside the installed app to see your personal link and dashboard.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, your referral link is generated the moment you sign in inside the installed Otter Quotes app. If it's on your home screen, open it now and sign in. Haven't installed it yet? Start here:`,
  ],
  ctaText: "Install & Sign In",
  ctaUrl: INSTALL_APP_URL,
};

const INSURANCE_AGENT_DAY7: StageCopySource = {
  subject: "Last reminder: activate your Otter Quotes account",
  preheader: "Sign in inside the app to get your link — this is the last nudge on this.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, this is the last automated reminder. Sign in inside the installed Otter Quotes app to activate your account and get your referral link — then share it with the first client you have in mind.`,
    "$200 referral fee on completed jobs of $10,000+. Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.",
  ],
  ctaText: "Sign In Now",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

const HOME_INSPECTOR_DAY0: StageCopySource = {
  subject: "Your Otter Quotes partner account is ready",
  preheader: "Install the app, then sign in inside it — that's what turns your account on.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN},`,
    "You're set up as an Otter Quotes partner. When your report flags roof or exterior damage, your clients get a real next step — competing repair bids, not one contractor's number scrawled on a business card.",
    "Two steps to get your link live:",
    '1. **Install the app.** iPhone: tap the button below, then in Safari tap the Share icon and choose **Add to Home Screen**. Android: tap "Install app" when prompted.',
    "2. **Open the app icon from your home screen and sign in there.** The installed app starts signed out — signing in inside it is what activates your account and unlocks your link.",
  ],
  ctaText: "Install the App",
  ctaUrl: INSTALL_APP_URL,
};

const HOME_INSPECTOR_DAY1: StageCopySource = {
  subject: "One step left: sign in inside the app",
  preheader: "Installed it yesterday? Open it and sign in — that's the step that activates your account.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, if you installed the Otter Quotes app yesterday, open it from your home screen and sign in — a fresh sign-in inside the installed app is what activates your account.`,
    "Haven't installed it yet? One tap below, then on iPhone: Share icon → Add to Home Screen.",
  ],
  ctaText: "Open & Sign In",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

const HOME_INSPECTOR_DAY3: StageCopySource = {
  subject: "Your link is one sign-in away",
  preheader: "Sign in inside the installed app to see your personal link and dashboard.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, your link is generated the moment you sign in inside the installed Otter Quotes app. If it's on your home screen, open it now and sign in. Haven't installed it yet? Start here:`,
  ],
  ctaText: "Install & Sign In",
  ctaUrl: INSTALL_APP_URL,
};

const HOME_INSPECTOR_DAY7: StageCopySource = {
  subject: "Last reminder: activate your Otter Quotes account",
  preheader: "Sign in inside the app to get your link — this is the last nudge on this.",
  paragraphs: [
    `Hi ${FIRST_NAME_TOKEN}, this is the last automated reminder. Sign in inside the installed Otter Quotes app to activate your account and get your link — then it's ready to hand your next client a real next step.`,
  ],
  ctaText: "Sign In Now",
  ctaUrl: PARTNER_APP_SIGNIN_URL,
};

type CopySourceTable = Record<EligibleAgentType, Record<OnboardingStage, StageCopySource>>;

// Exported READ-ONLY for copy.test.ts's regression guard only (Ben SHOULD,
// bus 14:01:57Z: "add a test asserting the copy constants are unchanged vs
// aae3acfc"). Not used by index.ts/run-sweep.ts — those only ever go through
// getCopyForAgentType/ONBOARDING_COPY.
export const COPY_SOURCE: CopySourceTable = {
  re_agent: { day0: RE_AGENT_DAY0, day1: RE_AGENT_DAY1, day3: RE_AGENT_DAY3, day7: RE_AGENT_DAY7 },
  insurance_agent: { day0: INSURANCE_AGENT_DAY0, day1: INSURANCE_AGENT_DAY1, day3: INSURANCE_AGENT_DAY3, day7: INSURANCE_AGENT_DAY7 },
  home_inspector: { day0: HOME_INSPECTOR_DAY0, day1: HOME_INSPECTOR_DAY1, day3: HOME_INSPECTOR_DAY3, day7: HOME_INSPECTOR_DAY7 },
};

type CopyTable = Record<EligibleAgentType, Record<OnboardingStage, EmailCopy>>;

const AGENT_TYPES: readonly EligibleAgentType[] = ["re_agent", "insurance_agent", "home_inspector"];
const STAGES: readonly OnboardingStage[] = ["day0", "day1", "day3", "day7"];

function buildCopyTable(): CopyTable {
  const table = {} as CopyTable;
  for (const agentType of AGENT_TYPES) {
    table[agentType] = {} as Record<OnboardingStage, EmailCopy>;
    for (const stage of STAGES) {
      table[agentType][stage] = renderStageCopy(COPY_SOURCE[agentType][stage]);
    }
  }
  return table;
}

export const ONBOARDING_COPY: CopyTable = buildCopyTable();

/** null for any agent_type outside the three eligible ones — caller decides
 * what "no copy" means (P-4 spec: those partners get no onboarding series). */
export function getCopyForAgentType(
  agentType: string | null | undefined,
  stage: OnboardingStage,
): EmailCopy | null {
  if (!AGENT_TYPES.includes(agentType as EligibleAgentType)) return null;
  return ONBOARDING_COPY[agentType as EligibleAgentType][stage];
}

/** True if ANY of subject/textBody/htmlBody still carries the placeholder
 * marker. Checked on the FINAL copy (after any [TEST] prefix or other
 * transform) so a bug in a transform step can never accidentally strip the
 * marker and let placeholder text ship. */
export function hasPlaceholderCopy(copy: EmailCopy): boolean {
  return (
    copy.subject.includes(PLACEHOLDER_MARKER) ||
    copy.textBody.includes(PLACEHOLDER_MARKER) ||
    copy.htmlBody.includes(PLACEHOLDER_MARKER)
  );
}

// ─── Unsubscribe / CAN-SPAM footer line ────────────────────────────────────
//
// D-320 (send-homeowner-next-steps) puts a signed, per-recipient opt-out
// link in a footer, in BOTH bodies, on every message of the series. This
// mirrors that for partners: ONE template — not per agent_type/day, since
// the wording doesn't vary — containing the FULL "Shared mechanics" CAN-SPAM
// footer block from 5821400303 (brand-service line, why-you're-receiving-
// this line, mailing address, unsubscribe, and the support contact line),
// verbatim except the mailing-address gap, which 5825271438 resolves to
// D-237's POSTAL_ADDRESS, and [UNSUBSCRIBE_URL], which becomes the
// {{optOutUrl}} substitution token (same mechanism as this file's
// pre-existing OPT_OUT_URL_TOKEN).

export const OPT_OUT_URL_TOKEN = "{{optOutUrl}}";

/** The approved CAN-SPAM footer / unsubscribe line, verbatim per 5821400303
 * with the mailing address filled in per 5825271438. Must keep the
 * {{optOutUrl}} token somewhere in the line, or the real per-partner
 * unsubscribe link will never render. */
export function getUnsubscribeLineTemplate(): string {
  return (
    "Otter Quotes is a service of Stellar Edge Services LLC. You're receiving this because you signed up as an Otter Quotes referral partner. " +
    `${POSTAL_ADDRESS} · Manage email preferences / Unsubscribe: ${OPT_OUT_URL_TOKEN} · ` +
    "Questions? Reply to this email or contact support@otterquote.com / (317) 501-9215."
  );
}

function renderUnsubscribeLine(optOutUrl: string, template: string): string {
  return template.split(OPT_OUT_URL_TOKEN).join(optOutUrl);
}

/** Ben SHOULD (bus 14:01:57Z, REVIEW FAIL 5833587935): "a clickable
 * unsubscribe <a> in the HTML body" — the footer line previously rendered
 * the opt-out URL as plain escaped text in the HTML body (clickable only via
 * the RFC 8058 List-Unsubscribe mailbox-provider header, added separately in
 * index.ts/run-sweep.ts). This wraps the SAME already-escaped URL in an
 * anchor instead of changing what URL is used or any surrounding word of
 * the approved copy. `optOutUrlEscaped` must already be HTML-escaped by the
 * caller (composeFinalCopy) — this function does not escape it again. */
function renderUnsubscribeLineHtml(optOutUrlEscaped: string, template: string): string {
  const anchor = `<a href="${optOutUrlEscaped}" style="color:inherit;">${optOutUrlEscaped}</a>`;
  return template.split(OPT_OUT_URL_TOKEN).join(anchor);
}

// ── PR #2162 review 5822537570 (gh-2154 P-4): the same rule applied to P-3's
// notify-admin-new-partner -- HTML-escape every dynamic value this module
// interpolates into htmlBody, and never let raw CR/LF reach an email header
// (the subject). The dynamic values here are the signed opt-out URL and the
// partner-supplied first_name (both per-partner, both substituted by
// composeFinalCopy below); the plain-text body is exempt, per Ben's ruling.

function stripHeaderInjection(str: string): string {
  return String(str).replace(/[\r\n]+/g, " ");
}

/** `{{first_name}}` merge field: substituted by composeFinalCopy. Falls back
 * to "there" when the partner has no first_name on file — same convention
 * send-homeowner-next-steps/email-content.ts uses for homeownerName. */
export function resolveFirstName(firstName: string | null | undefined): string {
  const trimmed = (firstName ?? "").trim();
  return trimmed.length > 0 ? trimmed : "there";
}

function renderFirstName(str: string, resolvedFirstName: string): string {
  return str.split(FIRST_NAME_TOKEN).join(resolvedFirstName);
}

/**
 * The FINAL, sendable copy for one (partner, stage): the per-agent_type/day
 * body from getCopyForAgentType with `{{first_name}}` substituted, the
 * [TEST] prefix (is_test partners only), and the D-320-mirrored CAN-SPAM
 * footer/unsubscribe line with this partner's real signed link substituted
 * in. This is the ONLY function run-sweep.ts calls hasPlaceholderCopy() on —
 * checking the base copy alone would miss a still-placeholder unsubscribe
 * line, and checking the base copy is no longer sufficient on its own now
 * that a second placeholder source exists.
 *
 * `unsubLineTemplate` defaults to the real (approved) module-level template;
 * tests override it to prove the token-substitution mechanics independently
 * of the real Tier C copy.
 */
export function composeFinalCopy(
  baseCopy: EmailCopy,
  optOutUrl: string,
  subjectPrefix: string,
  unsubLineTemplate: string = getUnsubscribeLineTemplate(),
  firstName: string | null | undefined = undefined,
): EmailCopy {
  const resolvedFirstName = resolveFirstName(firstName);

  // Text body: raw values, unescaped -- Ben's ruling exempts plain text.
  const unsubLineText = renderUnsubscribeLine(optOutUrl, unsubLineTemplate);
  const textBodyWithName = renderFirstName(baseCopy.textBody, resolvedFirstName);
  // HTML body: every dynamic value (optOutUrl, first_name) is HTML-escaped
  // before it lands in markup; the static template text around it is
  // Sloane's own copy, not partner-supplied, so it is not re-escaped here.
  const unsubLineHtml = renderUnsubscribeLineHtml(escapeHtml(optOutUrl), unsubLineTemplate);
  const htmlBodyWithName = renderFirstName(baseCopy.htmlBody, escapeHtml(resolvedFirstName));

  return {
    subject: stripHeaderInjection(renderFirstName(`${subjectPrefix}${baseCopy.subject}`, resolvedFirstName)),
    textBody: `${textBodyWithName}\n\n${unsubLineText}`,
    htmlBody: `${htmlBodyWithName}<p>${unsubLineHtml}</p>`,
  };
}
