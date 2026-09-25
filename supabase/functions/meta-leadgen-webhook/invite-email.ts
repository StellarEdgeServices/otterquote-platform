// gh-2154 P-5r (LEGAL-READ FAIL 5833717530) — the Meta-lead partner invite
// email: composes the message and decides whether to actually send it.
// Pure/testable (no network, no Mailgun import) -- index.ts wires the real
// Mailgun fetch and env-var switch read.
//
// COPY: Dustin APPROVED verbatim (bus 2026-09-25T18:00:33Z / #2154 comment
// 5837072371), from the draft at
// In-Flight/reports/ceo69-p5-invite-copy-20260925.md (Sloane, CEO RUN 69).
// Subject/body/CTA below for RE-2/INS-2/HI-2 are that draft's "Email 1"
// text verbatim, per agent_type. Two things NOT done here, both explicit
// in that approval:
//   1. The 48h reminder email (draft's "Reminder" block) -- a separate,
//      "recommended" follow-up, not built this round; only Email 1 exists.
//   2. The footer's unsubscribe LINK -- the approved footer text below is
//      used verbatim, but no opt-out token/URL is wired to it yet. The
//      natural fit is reusing the SAME already-deployed mechanism
//      send-partner-onboarding uses (PARTNER_ONBOARDING_OPTOUT_SECRET ->
//      partner-email-optout), not a new one -- flagged as an owed item in
//      this PR's evidence, not silently shipped as either a dead link or
//      a missing legally-required element. PARTNER_INVITE_EMAIL_ENABLED
//      defaults OFF regardless (see index.ts), so this is inert either way
//      until that link is wired AND the switch is flipped at go-live.
//
// Ben's own open flag on the approval (not Dustin's to fix without asking,
// per that same comment): the footer line "you signed up as an Otter
// Quotes referral partner" doesn't quite fit an invitee who only "asked to
// join" via a Meta lead form. Left exactly as Dustin approved it --
// unchanged pending his call, per Ben's note.

import { buildPartnerInviteUrl } from "./invite-token.ts";

/** Dustin-approved footer (#2154 comment 5837072371), verbatim from the
 * P-4 sequence per D-237. UNSUBSCRIBE_URL has no real link wired yet (see
 * header comment) -- left as an explicit, clearly-marked placeholder
 * rather than a dead/fake URL. */
const POSTAL_ADDRESS_ONLY = "3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

function buildFooter(escapeForHtml: boolean): string {
  const unsubText = escapeForHtml
    ? `<a href="#" style="color:inherit;">[UNSUBSCRIBE_URL -- opt-out link not yet wired]</a>`
    : `[UNSUBSCRIBE_URL -- opt-out link not yet wired]`;
  return (
    `Otter Quotes is a service of Stellar Edge Services LLC. You're receiving this because you signed up as an Otter Quotes referral partner. ` +
    `${POSTAL_ADDRESS_ONLY} · ` +
    `Manage email preferences / Unsubscribe: ${unsubText} · ` +
    `Questions? Reply to this email or contact support@otterquote.com / (317) 501-9215.`
  );
}

/** Dustin-approved (5837072371) per-agent_type "why join" sentence from
 * Email 1's body -- the one line that differs across RE-2/INS-2/HI-2.
 * HI-2 deliberately carries zero fee/bonus language (D-333). */
function benefitSentence(agentType: string): string {
  switch (agentType) {
    case "insurance_agent":
      return "When a storm claim comes in, give your client a faster way to get competing repair bids — instead of the first door-knocker who shows up.";
    case "home_inspector":
      return "When your report flags roof or exterior damage, give your clients a real next step — a link to competing contractor bids, not just a business card.";
    case "re_agent":
    default:
      return "Once you're set up, give your clients a faster way to get competing repair bids — after an inspection, or before a listing goes live.";
  }
}

/** Dustin-approved (5837072371) opening line -- HI-2's own draft omits
 * "as a referral partner" (home inspectors don't have a fee-bearing
 * referral role, D-333); every other agent_type keeps it. */
function openingLine(agentType: string): string {
  return agentType === "home_inspector"
    ? "You asked to join Otter Quotes through our form on Facebook or Instagram. You're almost there — three quick steps:"
    : "You asked to join Otter Quotes as a referral partner through our form on Facebook or Instagram. You're almost there — three quick steps:";
}

/** Dustin-approved (5837072371) step 3 -- HI-2's own draft omits "and gets
 * you your referral link" (no referral-fee link for inspectors, D-333). */
function stepThree(agentType: string): string {
  return agentType === "home_inspector"
    ? "Install the app and sign in inside it — that's what activates your account."
    : "Install the app and sign in inside it — that's what activates your account and gets you your referral link.";
}

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

/** siteBaseUrl e.g. "https://otterquote.com" (no trailing slash needed).
 * Copy is Dustin-approved (#2154 5837072371) -- see the header comment for
 * exactly what is/isn't covered by that approval. */
export function buildInviteEmail(firstName: string, agentType: string, siteBaseUrl: string, token: string): InviteEmail {
  const page = inviteTargetPage(agentType);
  const url = buildPartnerInviteUrl(`${siteBaseUrl.replace(/\/$/, "")}/${page}`, token);
  const name = firstName || "there";

  const subject = `You're almost in, ${name} — finish your Otter Quotes signup`;
  const opening = openingLine(agentType);
  const benefit = benefitSentence(agentType);
  const step3 = stepThree(agentType);
  const footerText = buildFooter(false);
  const footerHtml = buildFooter(true);

  const text =
    `Hi ${name},\n\n` +
    `${opening}\n\n` +
    `1. Open the link below. Your name, email and phone are already filled in.\n` +
    `2. Review and accept the Partner Agreement, then set a password.\n` +
    `3. ${step3}\n\n` +
    `${benefit}\n\n` +
    `Finish My Signup: ${url}\n\n` +
    `${footerText}`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1F2937;">` +
    `<p>Hi ${name},</p>` +
    `<p>${opening}</p>` +
    `<ol>` +
    `<li><strong>Open the link below.</strong> Your name, email and phone are already filled in.</li>` +
    `<li><strong>Review and accept the Partner Agreement</strong>, then set a password.</li>` +
    `<li><strong>${step3}</strong></li>` +
    `</ol>` +
    `<p>${benefit}</p>` +
    `<p><a href="${url}">Finish My Signup</a></p>` +
    `<p style="font-size:12px;color:#64748B;">${footerHtml}</p>` +
    `</div>`;

  return { subject, text, html };
}
