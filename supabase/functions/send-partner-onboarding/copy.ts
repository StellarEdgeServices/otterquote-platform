// gh-2154 P-4 — placeholder copy module.
//
// Copy is Tier C (Sloane approves the words before any real partner sees
// them — same rule the homeowner nudge's welcome-hook.ts documents for its
// own draft copy). Every subject/body below is an OBVIOUS placeholder using
// the `[[...]]` bracket convention so it can never be mistaken for real
// copy and so hasPlaceholderCopy() below can find it mechanically. Sloane
// fills these in; nothing else about this file changes when she does — see
// the build report for the full fill-in list, one entry per agent_type ×
// day, subject + body.
//
// This is the ONLY place copy lives for this function. index.ts must never
// inline copy — that was the whole point of gh-1786's identical move for
// the homeowner function (see send-homeowner-next-steps/email-content.ts).

import type { EligibleAgentType, OnboardingStage } from "./onboarding-stage.ts";

export interface EmailCopy {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/** Any field containing this substring is placeholder copy, never sendable. */
export const PLACEHOLDER_MARKER = "[[";

function placeholder(agentType: EligibleAgentType, stage: OnboardingStage, field: "subject" | "body"): string {
  return `[[P4 COPY: ${agentType} ${stage} ${field}]]`;
}

function buildStageCopy(agentType: EligibleAgentType, stage: OnboardingStage): EmailCopy {
  const body = placeholder(agentType, stage, "body");
  return {
    subject: placeholder(agentType, stage, "subject"),
    textBody: body,
    htmlBody: `<p>${body}</p>`,
  };
}

type CopyTable = Record<EligibleAgentType, Record<OnboardingStage, EmailCopy>>;

const AGENT_TYPES: readonly EligibleAgentType[] = ["re_agent", "insurance_agent", "home_inspector"];
const STAGES: readonly OnboardingStage[] = ["day0", "day1", "day3", "day7"];

function buildCopyTable(): CopyTable {
  const table = {} as CopyTable;
  for (const agentType of AGENT_TYPES) {
    table[agentType] = {} as Record<OnboardingStage, EmailCopy>;
    for (const stage of STAGES) {
      table[agentType][stage] = buildStageCopy(agentType, stage);
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

// ─── Kevin correction (Q1): unsubscribe line, off the D-320 pattern ────────
//
// D-320 (send-homeowner-next-steps) puts a signed, per-recipient opt-out
// link in a footer, in BOTH bodies, on every message of the series. This
// mirrors that for partners: ONE copy line — not per agent_type/day, since
// the wording doesn't need to vary — that Sloane fills in exactly once, and
// which MUST contain the {{optOutUrl}} token so the real per-partner link
// gets substituted in at render time. Until Sloane replaces it, it stays an
// obvious placeholder (still contains `[[`), so composeFinalCopy's message
// keeps failing hasPlaceholderCopy — same mechanism as the per-stage copy
// above, deliberately reused rather than invented twice.

export const OPT_OUT_URL_TOKEN = "{{optOutUrl}}";

/** Sloane fills this in — must keep the {{optOutUrl}} token somewhere in the
 * line, or the real per-partner unsubscribe link will never render. */
export function getUnsubscribeLineTemplate(): string {
  return `[[P4 COPY: unsubscribe line — must include ${OPT_OUT_URL_TOKEN}]]`;
}

function renderUnsubscribeLine(optOutUrl: string, template: string): string {
  return template.split(OPT_OUT_URL_TOKEN).join(optOutUrl);
}

// ── PR #2162 review 5822537570 (gh-2154 P-4): the same rule applied to P-3's
// notify-admin-new-partner -- HTML-escape every dynamic value this module
// interpolates into htmlBody, and never let raw CR/LF reach an email header
// (the subject). Today the only such dynamic value is the signed opt-out
// URL; this is still the correct place to escape, since composeFinalCopy is
// the single boundary where a per-partner value reaches the HTML body (see
// this file's header comment: Sloane's real copy may add further
// {{token}}-shaped substitutions later, and they will flow through here
// too). The plain-text body is exempt, per Ben's ruling.

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHeaderInjection(str: string): string {
  return String(str).replace(/[\r\n]+/g, " ");
}

/**
 * The FINAL, sendable copy for one (partner, stage): the per-agent_type/day
 * body from getCopyForAgentType, the [TEST] prefix (is_test partners only),
 * and the D-320-mirrored unsubscribe line with this partner's real signed
 * link substituted in. This is the ONLY function run-sweep.ts calls
 * hasPlaceholderCopy() on — checking the base copy alone would miss a
 * still-placeholder unsubscribe line, and checking the base copy is no
 * longer sufficient on its own now that a second placeholder source exists.
 *
 * `unsubLineTemplate` defaults to the real (module-level) template; tests
 * override it to prove the token-substitution mechanics against a filled-in
 * template without waiting on Sloane's actual copy.
 */
export function composeFinalCopy(
  baseCopy: EmailCopy,
  optOutUrl: string,
  subjectPrefix: string,
  unsubLineTemplate: string = getUnsubscribeLineTemplate(),
): EmailCopy {
  // Text body: raw value, unescaped -- Ben's ruling exempts plain text.
  const unsubLineText = renderUnsubscribeLine(optOutUrl, unsubLineTemplate);
  // HTML body: the dynamic value (optOutUrl) is HTML-escaped before it lands
  // in markup; the static template text around it is Sloane's own copy, not
  // partner-supplied, so it is not re-escaped here.
  const unsubLineHtml = renderUnsubscribeLine(escapeHtml(optOutUrl), unsubLineTemplate);
  return {
    subject: stripHeaderInjection(`${subjectPrefix}${baseCopy.subject}`),
    textBody: `${baseCopy.textBody}\n\n${unsubLineText}`,
    htmlBody: `${baseCopy.htmlBody}<p>${unsubLineHtml}</p>`,
  };
}
