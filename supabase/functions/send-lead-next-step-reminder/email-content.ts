// gh-2121 (LRS HO-1 S21) — the approved copy, verbatim.
//
// Source: issue #2121, comment 5821796976 (Sloane, CRO, CEO RUN 67,
// "HO-1 S21 next-step reminder — PROPOSED copy"). Approved by Dustin,
// comment 5824921642: "HO-1 S21, next-step reminder email copy (5821796976):
// '2. Approved'."
//
// Tier C (copy). Nothing below may be reworded — this file exists so the
// exact approved subject/preheader/body/footer are a single, testable
// source of truth instead of being retyped inline in index.ts (the
// send-homeowner-next-steps precedent this mirrors, email-content.ts there).
//
// CTA destinations are the SAME live deep links the Arm F thank-you screen
// already uses (js/router-variant-f.js's own CTA_DESTINATIONS:
// `measure: 'https://app.otterquote.com/help-measurements'`,
// `loss_sheet: 'https://app.otterquote.com/help-estimate'`), with
// `?lead=<id>` appended — this email does not append the extra attribution
// params `redirectWithLeadId()` adds client-side on the router's own
// same-visit redirect (an email open is a fresh, unattributed context; the
// lead id alone is what #2163's set_lead_converted()/help-measurements/
// help-estimate flow needs).

export const APP_BASE_URL = "https://app.otterquote.com";
export const MEASUREMENT_CTA_PATH = "/help-measurements";
export const LOSS_SHEET_CTA_PATH = "/help-estimate";

export const SUBJECT = "Next step on your roof assessment";

export const PREHEADER =
  "Two quick ways to keep things moving while you wait to hear from Dustin.";

// Verbatim from comment 5821796976's own fenced body block, including the
// literal "{first_name}" placeholder — 80 words by the same
// `len(body.split())` check that comment's own "Body word count: 80" line
// records (see email-content.test.ts).
export const BODY_TEMPLATE =
  `Hi {first_name},

We've got your roof assessment request. Dustin will still call you
directly -- this is just a faster way to move things along while you
wait.

Two quick options:

Already have your insurance loss sheet? Upload it now and we'll start
matching you with a contractor.

Want bids ready sooner? Get a $15 measurement report ($15, rebated if
you use an Otter Quotes contractor) -- no ladder, no appointment,
nothing to photograph.

Either one keeps your project moving.`;

// Fix round 1 (CEO RUN 68 LEGAL-READ: FAIL, comment 5825694840, must-fix 6,
// Ben's D-332 conservative ruling): for a lead with NO phone number on
// file, the sentence promising a call from Dustin ("Dustin will still call
// you directly -- this is just a faster way to move things along while you
// wait.") must be omitted -- there is no number to call. Removal only, no
// new words added; every other word in BODY_TEMPLATE is unchanged and in
// the same order (diff the two constants to confirm). Leads WITH a phone
// keep getting BODY_TEMPLATE unchanged, verbatim, per the approved copy.
export const BODY_TEMPLATE_NO_PHONE =
  `Hi {first_name},

We've got your roof assessment request.

Two quick options:

Already have your insurance loss sheet? Upload it now and we'll start
matching you with a contractor.

Want bids ready sooner? Get a $15 measurement report ($15, rebated if
you use an Otter Quotes contractor) -- no ladder, no appointment,
nothing to photograph.

Either one keeps your project moving.`;

// gh-2378 (CRO51) -- HO-6 (/ho6) "next steps" email, Variant A, verbatim from
// In Flight/drafts/cro50-ho6-next-step-email-DRAFT-20260930.md. Dustin chose
// "A, Reply-To you" on #2378 (comment 5911291213). Only {first_name} is
// substituted. No CTA links (the reply IS the next step), no call promise, no
// price. The footer below is the existing template footer, unchanged.
export const HO6_VARIANT = "ho6";
export const HO6_SUBJECT = "Your next step with Otter Quotes";
export const HO6_PREHEADER =
  "Reply with a few lines about your job and we'll take it from there.";
export const HO6_BODY_TEMPLATE =
  `Hi {first_name},

Thanks for reaching out to Otter Quotes. Your next step is simple: reply to this email and tell us about your job in a few lines, in your own words. What needs to be done, and anything else you think we should know.

From there we help you create a scope of work and send it to multiple contractors, so you can compare their bids.

Contractors compete. Homeowners win.

The Otter Quotes team`;
/** Reply-To for ho6 sends only (Dustin's choice, #2378 comment 5911291213). */
export const HO6_REPLY_TO = "dustinstohler1@gmail.com";

/** Reply-To for a lead's variant: the address for "ho6", undefined for every other variant. */
export function replyToForVariant(variant: string | null | undefined): string | undefined {
  return variant === HO6_VARIANT ? HO6_REPLY_TO : undefined;
}

export const LOSS_SHEET_CTA_LABEL = "Upload your loss sheet";
export const MEASUREMENT_CTA_LABEL = "Get the $15 measurement report";

/** The D-237 postal address, same resolved value used by
 * send-homeowner-next-steps/email-footer.ts and this repo's other homeowner
 * commercial-email templates. */
export const POSTAL_ADDRESS =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

export const FROM_ADDRESS = "Otter Quotes <notifications@mail.otterquote.com>";

export const OPTOUT_LINK_TEXT = "Stop these updates";
// Fix round 1 (CEO RUN 68 LEGAL-READ: FAIL, comment 5825694840, must-fix 7 /
// adversarial test A3): OPTOUT_TEXT_LINE previously already ended in
// "Stop these updates:", and buildLeadReminderEmail's HTML footer appended
// an <a> whose text was ALSO "Stop these updates" right after it, rendering
// "Don't want these emails? Stop these updates: Stop these updates". The
// phrase now appears exactly once in each of textBody and htmlBody: this
// line asks the question only, and the link (OPTOUT_LINK_TEXT) supplies
// "Stop these updates" itself, in both bodies.
export const OPTOUT_TEXT_LINE = "Don't want these emails?";

function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function measurementCtaUrl(leadId: string): string {
  return `${APP_BASE_URL}${MEASUREMENT_CTA_PATH}?lead=${encodeURIComponent(leadId)}`;
}

export function lossSheetCtaUrl(leadId: string): string {
  return `${APP_BASE_URL}${LOSS_SHEET_CTA_PATH}?lead=${encodeURIComponent(leadId)}`;
}

// Fix round 1 (CEO RUN 68 REVIEW: FAIL, comment 5825698253, should-fix /
// adversarial tests A10-A11): `leads.name` is free-text, untrusted user
// input. Before this fix, firstNameOf() only took the first whitespace
// token, so a name like "http://evil.example/x" landed RAW in textBody (no
// HTML there to escape it) and a name containing "$&" broke
// `String.prototype.replace`'s special replacement-pattern handling,
// corrupting the greeting. This restricts the first name to letters,
// apostrophes and hyphens only (a superset of any real first name this
// form should ever collect), capped at 40 characters, falling back to
// "there" for anything else -- including anything that looks like it
// contains a URL scheme or an "@".
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z'-]{0,39}$/;

/** first_name falls back to "there" for a lead with no name on file (same
 * fallback convention send-homeowner-next-steps/email-content.ts uses), or
 * for any name that does not look like a plain first name once sanitized. */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "there";
  const firstToken = trimmed.split(/\s+/)[0].slice(0, 40);
  return SAFE_NAME_RE.test(firstToken) ? firstToken : "there";
}

export interface LeadReminderEmail {
  subject: string;
  preheader: string;
  textBody: string;
  htmlBody: string;
}

function buildHo6Email(firstName: string, optOutUrl: string): LeadReminderEmail {
  const body = HO6_BODY_TEMPLATE.replace("{first_name}", () => firstName);
  // Same footer construction as buildLeadReminderEmail, unchanged.
  const textBody =
    `${body}\n\n` +
    `${FROM_ADDRESS}\n\n` +
    `${POSTAL_ADDRESS}\n\n` +
    `${OPTOUT_TEXT_LINE} ${OPTOUT_LINK_TEXT}: ${optOutUrl}`;
  const htmlBody =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">` +
    `<p style="display:none;max-height:0;overflow:hidden;">${escapeHtml(HO6_PREHEADER)}</p>` +
    body
      .split("\n\n")
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("\n") +
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0;">` +
    `<p style="font-size:12px;color:#666;">${escapeHtml(FROM_ADDRESS)}<br>` +
    `${escapeHtml(POSTAL_ADDRESS)}<br>` +
    `${escapeHtml(OPTOUT_TEXT_LINE)} <a href="${optOutUrl}" style="color:#666;">${escapeHtml(OPTOUT_LINK_TEXT)}</a>` +
    `</p>` +
    `</div>`;
  return { subject: HO6_SUBJECT, preheader: HO6_PREHEADER, textBody, htmlBody };
}

export function buildLeadReminderEmail(
  leadId: string,
  name: string | null | undefined,
  optOutUrl: string,
  // Fix round 1 (must-fix 6, Ben's D-332 ruling): defaults to true so any
  // existing caller that has not been updated yet keeps sending the
  // call-promise sentence (the safe default is the APPROVED copy, unchanged)
  // -- index.ts is the one caller in this repo and always passes the real
  // value explicitly.
  hasPhone = true,
  // gh-2378: lead's leads.variant. Only the exact value "ho6" changes anything;
  // undefined / any other value renders the existing copy byte-for-byte.
  variant?: string | null,
): LeadReminderEmail {
  const firstName = firstNameOf(name);
  if (variant === HO6_VARIANT) {
    return buildHo6Email(firstName, optOutUrl);
  }
  const template = hasPhone ? BODY_TEMPLATE : BODY_TEMPLATE_NO_PHONE;
  // Fix round 1 (should-fix, adversarial test A11): a function replacer
  // (`() => firstName`) is used instead of `template.replace("{first_name}",
  // firstName)` — the string form of replace() treats "$&", "$1", "$$" etc.
  // in the REPLACEMENT as special patterns, so a firstName of "$&" would
  // duplicate the match instead of inserting literally. A function
  // replacer's return value is always inserted verbatim. firstNameOf()
  // already restricts firstName to [A-Za-z'-], which cannot contain "$"
  // anyway — this is defense in depth, not the only fix for that case.
  const body = template.replace("{first_name}", () => firstName);
  const lossSheetUrl = lossSheetCtaUrl(leadId);
  const measurementUrl = measurementCtaUrl(leadId);

  const textBody =
    `${body}\n\n` +
    `${LOSS_SHEET_CTA_LABEL}: ${lossSheetUrl}\n` +
    `${MEASUREMENT_CTA_LABEL}: ${measurementUrl}\n\n` +
    `${FROM_ADDRESS}\n\n` +
    `${POSTAL_ADDRESS}\n\n` +
    `${OPTOUT_TEXT_LINE} ${OPTOUT_LINK_TEXT}: ${optOutUrl}`;

  const htmlBody =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">` +
    `<p style="display:none;max-height:0;overflow:hidden;">${escapeHtml(PREHEADER)}</p>` +
    body
      .split("\n\n")
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("\n") +
    `<p>` +
    `<a href="${lossSheetUrl}" style="color:#0a5;">${escapeHtml(LOSS_SHEET_CTA_LABEL)}</a><br>` +
    `<a href="${measurementUrl}" style="color:#0a5;">${escapeHtml(MEASUREMENT_CTA_LABEL)}</a>` +
    `</p>` +
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0;">` +
    `<p style="font-size:12px;color:#666;">${escapeHtml(FROM_ADDRESS)}<br>` +
    `${escapeHtml(POSTAL_ADDRESS)}<br>` +
    `${escapeHtml(OPTOUT_TEXT_LINE)} <a href="${optOutUrl}" style="color:#666;">${escapeHtml(OPTOUT_LINK_TEXT)}</a>` +
    `</p>` +
    `</div>`;

  return { subject: SUBJECT, preheader: PREHEADER, textBody, htmlBody };
}
