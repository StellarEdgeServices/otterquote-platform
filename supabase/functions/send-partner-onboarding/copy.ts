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
