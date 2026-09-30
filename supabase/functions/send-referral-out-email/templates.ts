// templates.ts (gh-2019 / D-324)
//
// The approved D-324 referral-out email, rendered as pure functions (no I/O,
// no Date, no Deno.env) so `deno test` can pin every byte.
//
// SOURCE OF THE STRING: GitHub #2019 comment 5731910268 (subject + body), which
// Dustin approved verbatim ("Approved.", comment 5731950394: "The string ships
// exactly as drafted, subject line included") and which D-324 registers. It is
// NOT paraphrasable: the no-representation sentence is the clause doing the
// legal work (D-104). Do not "tighten", re-wrap or re-punctuate any line of
// APPROVED_BODY_LINES. The only variable parts are the four placeholders.
//
// PLACEHOLDERS (the only substitutions ever made):
//   {{first_name}}  the stored `leads.name` (the arm-E `e-p5-5` answer to
//                   "How should I address you?"), VERBATIM, no parsing -- Ben's
//                   ruling, #2019 comment 5889011634. CR/LF stripped, and
//                   HTML-escaped in the HTML body only. Trimmed for the
//                   emptiness test ONLY; if it is empty or whitespace-only
//                   nothing is sent (see buildNoNameAlert) and there is no
//                   fallback greeting.
//   {{name}} {{phone}} {{website}}  one line per contractor, three lines, the
//                   three names Dustin supplies from OUTSIDE our own network
//                   (D-249). Structured fields only (D-215 template posture).
//
// The D-237 postal footer (./email-footer.ts) is appended AFTER the approved
// body; it is not part of the approved string.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

export const REFERRAL_OUT_VARIANT = "e-referral-out";

export const APPROVED_SUBJECT = "The contractors you asked for";

// The approved body, one array element per physical line (hard wraps included,
// exactly as approved), joined with "\n". No trailing newline.
export const APPROVED_BODY_LINES: readonly string[] = [
  "Hi {{first_name}},",
  "",
  "You asked us to send you the contact information for contractors who work the",
  "way you described. Here they are:",
  "",
  "  {{name}} - {{phone}} - {{website}}",
  "  {{name}} - {{phone}} - {{website}}",
  "  {{name}} - {{phone}} - {{website}}",
  "",
  "We make no representation about these companies' licensing, insurance, work or",
  "pricing, and we are not a party to anything you do with them. We are sending",
  "their contact information because you asked for it.",
  "",
  "If you change your mind and would rather have contractors compete for your",
  "project, you can come back any time: https://otterquote.com/start",
  "",
  "This is a one-time message. We will not email you again unless you ask.",
  "",
  "- The Otter Quotes team",
];

export const APPROVED_BODY_TEMPLATE: string = APPROVED_BODY_LINES.join("\n");

const CONTRACTOR_LINE_TEMPLATE = "  {{name}} - {{phone}} - {{website}}";

export interface ReferralContractor {
  name: string;
  phone: string;
  website: string;
}

export function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Removes every CR and LF (removed, not replaced with a space). */
export function stripCrLf(str: string): string {
  return String(str ?? "").replace(/[\r\n]/g, "");
}

/** True when the stored name is empty or only whitespace after trimming. */
export function isBlankName(name: unknown): boolean {
  return typeof name !== "string" || name.trim() === "";
}

export interface RenderedReferralEmail {
  subject: string;
  text: string;
  html: string;
}

// Single-pass placeholder fill: a value that itself contains "{{...}}" is never
// re-scanned, so a name like "{{phone}}" cannot pull another field in.
function fill(line: string, values: Record<string, string>): string {
  return line.replace(/\{\{(first_name|name|phone|website)\}\}/g, (_m, k: string) => values[k]);
}

function renderBody(
  firstName: string,
  contractors: readonly ReferralContractor[],
  esc: (s: string) => string,
): string {
  let ci = 0;
  return APPROVED_BODY_LINES.map((line) => {
    if (line === CONTRACTOR_LINE_TEMPLATE) {
      const c = contractors[ci++];
      return fill(line, {
        first_name: "",
        name: esc(stripCrLf(c.name)),
        phone: esc(stripCrLf(c.phone)),
        website: esc(stripCrLf(c.website)),
      });
    }
    return fill(line, { first_name: esc(stripCrLf(firstName)), name: "", phone: "", website: "" });
  }).join("\n");
}

/**
 * Renders the approved subject, plain-text body and HTML body. Caller must have
 * checked isBlankName(firstName) === false and supplied exactly three
 * contractors (validateContractors in send-core.ts); this throws otherwise so a
 * caller bug can never produce a partly-filled email.
 */
export function renderReferralOutEmail(
  firstName: string,
  contractors: readonly ReferralContractor[],
): RenderedReferralEmail {
  if (isBlankName(firstName)) throw new Error("renderReferralOutEmail: blank name (no fallback greeting exists)");
  if (contractors.length !== 3) throw new Error("renderReferralOutEmail: exactly three contractors required");

  const text = `${renderBody(firstName, contractors, (s) => s)}\n\n${footerPostalAddressText()}`;
  const html =
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1E293B;">` +
    `<div style="white-space:pre-wrap;">${renderBody(firstName, contractors, escapeHtml)}</div>` +
    `<div style="margin-top:24px;font-size:12px;color:#64748B;">${footerPostalAddressHtml()}</div>` +
    `</div>`;
  return { subject: APPROVED_SUBJECT, text, html };
}

// Ben's ruling (#2019 comment 5889011634): an empty/whitespace-only name means
// DO NOT SEND; raise the admin alert with "no name captured" instead. Kept in
// step with notify-admin-new-homeowner/notify-helpers.ts (drift test).
export const REFERRAL_OUT_NO_NAME_NOTE =
  "No name captured: the approved D-324 email was NOT sent to this requester (it opens with their name and no fallback greeting exists). Follow up by hand.";

export interface NoNameAlert {
  subject: string;
  text: string;
  html: string;
}

/** The admin-only alert raised INSTEAD of sending when no name was captured. */
export function buildNoNameAlert(lead: { id?: unknown; email?: unknown }): NoNameAlert {
  const email = typeof lead.email === "string" && lead.email.trim() !== "" ? stripCrLf(lead.email) : "(no email)";
  const id = typeof lead.id === "string" ? stripCrLf(lead.id) : "(unknown)";
  const subject = "[OtterQuote] Referral-out request: no name captured";
  const text = [
    "A referral-out request (D-324) could not be answered: no name captured.",
    `Lead id : ${id}`,
    `Email   : ${email}`,
    "",
    REFERRAL_OUT_NO_NAME_NOTE,
  ].join("\n");
  const html =
    `<p style="font-family:sans-serif;font-size:14px;">A referral-out request (D-324) could not be answered: no name captured.</p>` +
    `<p style="font-family:sans-serif;font-size:14px;">Lead id: ${escapeHtml(id)}<br>Email: ${escapeHtml(email)}</p>` +
    `<p style="font-family:sans-serif;font-size:12px;color:#94A3B8;">${escapeHtml(REFERRAL_OUT_NO_NAME_NOTE)}</p>`;
  return { subject, text, html };
}
