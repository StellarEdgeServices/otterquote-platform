// gh-2154 P-5r (LEGAL-READ FAIL 5833717530) — the Meta-lead partner invite
// email: composes the message and decides whether to actually send it.
// Pure/testable (no network, no Mailgun import) -- index.ts wires the real
// Mailgun fetch and env-var switch read.
//
// COPY IS A PLACEHOLDER. Every visible string below is wrapped with
// "[PLACEHOLDER COPY -- ..." markers and is NOT approved customer-facing
// text -- Sloane is drafting the real subject/body for Dustin (per this
// build's brief). Do not ship with PARTNER_INVITE_EMAIL_ENABLED=true until
// that copy lands and replaces this. Structure (a link to accept, the
// unsubscribe-equivalent, and the D-237 postal address) mirrors
// send-partner-onboarding's own emails, which HAVE been through R-177.

import { POSTAL_ADDRESS } from "./email-footer.ts";
import { buildPartnerInviteUrl } from "./invite-token.ts";

export const PARTNER_INVITE_EMAIL_ENABLED_ENV = "PARTNER_INVITE_EMAIL_ENABLED";

/** The switch defaults OFF: only the literal string "true" enables sending. */
export function isInviteEmailEnabled(value: string | undefined): boolean {
  return value === "true";
}

// gh-2154 P-5 frontend round: every invite links to the ONE dedicated
// partner-invite.html accept page (GET-prefilled from this row's own
// agent_type via partner-invite-accept), not to any of the five live
// partner-*.html signup pages -- those collect a fresh signup, they do not
// know how to accept an existing pending row. inviteTargetPage() is kept
// (rather than inlining the literal) so callers/tests have one named seam,
// and because it still encodes "this is a per-agent_type routing decision"
// even though every branch currently resolves the same way.
const INVITE_TARGET_PAGE = "partner-invite.html";

/** Which page this agent_type's invite link should prefill and accept
 * through. Always partner-invite.html -- see comment above. */
export function inviteTargetPage(_agentType: string): string {
  return INVITE_TARGET_PAGE;
}

export interface InviteEmail {
  subject: string;
  text: string;
  html: string;
}

/** siteBaseUrl e.g. "https://otterquote.com" (no trailing slash needed). */
export function buildInviteEmail(firstName: string, agentType: string, siteBaseUrl: string, token: string): InviteEmail {
  const page = inviteTargetPage(agentType);
  const url = buildPartnerInviteUrl(`${siteBaseUrl.replace(/\/$/, "")}/${page}`, token);
  const name = firstName || "there";

  const subject = "[PLACEHOLDER COPY — subject not yet approved] Finish setting up your Otter Quotes partner account";

  const text =
    `[PLACEHOLDER COPY — body not yet approved]\n\n` +
    `Hi ${name},\n\n` +
    `Thanks for your interest in Otter Quotes. Finish setting up your partner account here:\n${url}\n\n` +
    `If you didn't request this, you can ignore this email.\n\n` +
    `${POSTAL_ADDRESS}`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1F2937;">` +
    `<p style="color:#B91C1C;font-weight:bold;">[PLACEHOLDER COPY — not yet approved]</p>` +
    `<p>Hi ${name},</p>` +
    `<p>Thanks for your interest in Otter Quotes. Finish setting up your partner account:</p>` +
    `<p><a href="${url}">Finish setting up your account</a></p>` +
    `<p>If you didn't request this, you can ignore this email.</p>` +
    `<p style="font-size:12px;color:#64748B;">${POSTAL_ADDRESS}</p>` +
    `</div>`;

  return { subject, text, html };
}
