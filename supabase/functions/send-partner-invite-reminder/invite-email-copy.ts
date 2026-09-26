// gh-2154 P-5 go-live (Ben, bus 2026-09-25T22:17:42Z item 2) -- copy shared
// between the initial invite email and its 48h reminder. Duplicated from
// meta-leadgen-webhook/invite-email.ts's own PARITY REGION (held byte-exact
// by invite-email-copy.parity.test.ts in this directory) -- this repo's
// Edge Function deploy path does not resolve imports across function
// directories. Only buildReminderEmail is actually called from this
// directory's index.ts; buildInviteEmail and its own per-agent-type helpers
// are carried along because splitting the parity region in two would be
// more fragile than keeping the whole shared block identical.

// ─── BEGIN PARITY REGION — edit both copies together ────────────────────────
// gh-2154 P-5 go-live: this region (everything the 48h reminder needs, plus
// the shared footer/switch/routing helpers) is duplicated byte-for-byte
// into send-partner-invite-reminder/invite-email-copy.ts (that directory's
// own cron-triggered sender), held in parity by that file's own
// invite-email-copy.parity.test.ts. buildInviteEmail/benefitSentence/
// openingLine/stepThree are the INITIAL invite's own text and are included
// here too (simpler than splitting the region) even though the reminder
// sender never calls them.

import { buildPartnerInviteUrl } from "./invite-token.ts";

/** REVIEW FAIL 5841303507 must-fix 3: firstName is attacker-controlled (any
 * caller can submit the Meta lead form with an arbitrary first_name), and
 * the HTML body interpolates it unescaped. Same escaping shape as
 * send-partner-onboarding/copy.ts's own escapeHtml -- text bodies are left
 * unescaped (plain text has no markup to inject into), only the HTML
 * bodies below run values through this first. */
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** REVIEW FAIL 5841303507 must-fix 5: the approved draft
 * (ceo69-p5-invite-copy-20260925.md, #2154 5837072371) specifies a hidden
 * preview-text preheader for both emails; neither shipped one. Same hidden
 * span pattern as send-partner-onboarding/copy.ts's renderStageCopy. */
const EMAIL1_PREHEADER =
  "You asked to join on Facebook/Instagram. Finish in about 60 seconds — your details are already filled in.";
const REMINDER_PREHEADER =
  "You started signing up — it only takes about 60 seconds to finish.";

function preheaderSpanHtml(text: string): string {
  return `<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(text)}</span>`;
}

/** Dustin-approved footer (#2154 comment 5837072371), verbatim from the
 * P-4 sequence per D-237, now with a real, signed unsubscribe link
 * (caller-supplied, already HMAC-verifiable -- see header comment). The
 * anchor pattern matches send-partner-onboarding/copy.ts's
 * renderUnsubscribeLineHtml exactly (a plain, already-safe URL wrapped in
 * an <a>, not re-escaped). */
const POSTAL_ADDRESS_ONLY = "3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

function buildFooter(optOutUrl: string, escapeForHtml: boolean): string {
  const unsubText = escapeForHtml
    ? `<a href="${optOutUrl}" style="color:inherit;">${optOutUrl}</a>`
    : optOutUrl;
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
 * optOutUrl must already be a real, signed unsubscribe URL (see optout.ts
 * -- index.ts builds it and refuses to send at all without one). Copy is
 * Dustin-approved (#2154 5837072371) -- see the header comment for exactly
 * what is/isn't covered by that approval. */
export function buildInviteEmail(firstName: string, agentType: string, siteBaseUrl: string, token: string, optOutUrl: string): InviteEmail {
  const page = inviteTargetPage(agentType);
  const url = buildPartnerInviteUrl(`${siteBaseUrl.replace(/\/$/, "")}/${page}`, token);
  const name = firstName || "there";

  const subject = `You're almost in, ${name} — finish your Otter Quotes signup`;
  const opening = openingLine(agentType);
  const benefit = benefitSentence(agentType);
  const step3 = stepThree(agentType);
  const footerText = buildFooter(optOutUrl, false);
  const footerHtml = buildFooter(optOutUrl, true);

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
    preheaderSpanHtml(EMAIL1_PREHEADER) +
    `<p>Hi ${escapeHtml(name)},</p>` +
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

// (buildInviteEmail above and buildReminderEmail below both stay inside
// the parity region — see the BEGIN comment.)

/** Dustin-approved (5837072371) 48h reminder subject -- HI-2's own draft
 * differs from RE-2/INS-2 ("your Otter Quotes account is waiting" vs
 * "your Otter Quotes referral link is waiting", no fee-bearing referral
 * link for inspectors, D-333). */
function reminderSubject(agentType: string): string {
  return agentType === "home_inspector"
    ? "Reminder: your Otter Quotes account is waiting"
    : "Reminder: your Otter Quotes referral link is waiting";
}

/** Dustin-approved (5837072371) 48h reminder body sentence -- same
 * "as a referral partner" omission for HI-2 as the initial invite email. */
function reminderBodySentence(agentType: string, name: string): string {
  return agentType === "home_inspector"
    ? `Hi ${name}, you started joining Otter Quotes but haven't finished yet. Your signup details are still filled in and waiting — accept the Partner Agreement, set a password, and you're in.`
    : `Hi ${name}, you started joining Otter Quotes as a referral partner but haven't finished yet. Your signup details are still filled in and waiting — accept the Partner Agreement, set a password, and you're in.`;
}

/**
 * gh-2154 P-5 go-live (Ben, bus 22:17:42Z item 2) -- the 48h reminder,
 * Dustin-approved (#2154 5837072371) verbatim from the same draft as
 * buildInviteEmail's "Reminder (recommended, send at 48h -- skip if the
 * agreement has already been accepted)" block. Skipping an already-
 * accepted partner is the CALLER's job (index.ts / the reminder sweep),
 * same as send-partner-onboarding's own selectStage stop conditions --
 * this function only composes the message, same separation of concerns
 * as buildInviteEmail.
 */
export function buildReminderEmail(firstName: string, agentType: string, siteBaseUrl: string, token: string, optOutUrl: string): InviteEmail {
  const page = inviteTargetPage(agentType);
  const url = buildPartnerInviteUrl(`${siteBaseUrl.replace(/\/$/, "")}/${page}`, token);
  const name = firstName || "there";

  const subject = reminderSubject(agentType);
  const bodySentence = reminderBodySentence(agentType, name);
  const bodySentenceHtml = reminderBodySentence(agentType, escapeHtml(name));
  const footerText = buildFooter(optOutUrl, false);
  const footerHtml = buildFooter(optOutUrl, true);

  const text =
    `${bodySentence}\n\n` +
    `Finish My Signup: ${url}\n\n` +
    `${footerText}`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1F2937;">` +
    preheaderSpanHtml(REMINDER_PREHEADER) +
    `<p>${bodySentenceHtml}</p>` +
    `<p><a href="${url}">Finish My Signup</a></p>` +
    `<p style="font-size:12px;color:#64748B;">${footerHtml}</p>` +
    `</div>`;

  return { subject, text, html };
}

// ─── END PARITY REGION 
