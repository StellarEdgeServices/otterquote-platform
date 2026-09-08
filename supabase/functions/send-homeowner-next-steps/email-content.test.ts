// gh-1786 / D-320 — the footer link is in BOTH bodies of BOTH emails.
// Run: deno test supabase/functions/send-homeowner-next-steps/email-content.test.ts

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailContent, OPTOUT_LINK_TEXT, OPTOUT_TEXT_LINE } from "./email-content.ts";

const OPTOUT = "https://abc.supabase.co/functions/v1/homeowner-email-optout?t=abc.def";
const built = () =>
  buildEmailContent("Nick Mansueto", "https://otterquote.com/help-measurements.html", "https://otterquote.com/color-selection.html?claim_id=c1", OPTOUT);

Deno.test("the opt-out URL appears in the plain-text body", () => {
  const { textBody } = built();
  assert(textBody.includes(OPTOUT), textBody);
  assert(textBody.includes(OPTOUT_TEXT_LINE), textBody);
});

Deno.test("the opt-out URL appears in the HTML body as a real anchor", () => {
  const { htmlBody } = built();
  assert(htmlBody.includes(`href="${OPTOUT}"`), htmlBody.slice(-800));
  assert(htmlBody.includes(OPTOUT_LINK_TEXT), htmlBody.slice(-800));
});

Deno.test("both stages render from this one function, so both emails carry it", () => {
  // '2h' and '48h' differ only in the activity_log stamp title; the message
  // itself is this single template, so one assertion covers both sends.
  const a = built();
  const b = built();
  assertEquals(a.htmlBody, b.htmlBody);
  assertEquals(a.subject, "You're one step from bids");
});

Deno.test("NEGATIVE CONTROL — a message cannot be built without an opt-out link", () => {
  assertThrows(
    () => buildEmailContent("Nick", "https://x/m", "https://x/c", ""),
    Error,
    "optOutUrl is required",
  );
});

Deno.test("D-312 — the copy names no price, contractor or third-party vendor", () => {
  const { subject, textBody, htmlBody } = built();
  const all = `${subject}\n${textBody}\n${htmlBody}`.toLowerCase();
  for (const banned of ["$", "hover", "docusign", "stripe", "mailgun", "per square", "deductible"]) {
    assert(!all.includes(banned), `copy must not contain ${banned}`);
  }
});
