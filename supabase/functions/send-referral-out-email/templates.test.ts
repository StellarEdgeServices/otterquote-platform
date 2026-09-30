// Deno unit tests for gh-2019 / D-324: the approved referral-out email.
// Run: deno test --no-check supabase/functions/send-referral-out-email/templates.test.ts
//
// EXACT-EQUALITY GOLDEN TESTS. Every expected string below is spelled out in
// full (never built from the template under test), so changing a single word,
// space, line break or punctuation mark of the approved copy fails them.
// The approved string itself is pinned twice: APPROVED_FIXTURE_* below is an
// independent copy of #2019 comment 5731910268 (approved by Dustin, comment
// 5731950394), and the template must equal it byte for byte.

import { assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  APPROVED_BODY_TEMPLATE,
  APPROVED_SUBJECT,
  buildNoNameAlert,
  isBlankName,
  REFERRAL_OUT_NO_NAME_NOTE,
  REFERRAL_OUT_VARIANT,
  renderReferralOutEmail,
} from "./templates.ts";
import {
  REFERRAL_OUT_NO_NAME_NOTE as NOTIFY_NO_NAME_NOTE,
  REFERRAL_OUT_VARIANT as NOTIFY_VARIANT,
} from "../notify-admin-new-homeowner/notify-helpers.ts";

const ADDR = "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

const APPROVED_FIXTURE_SUBJECT = "The contractors you asked for";
const APPROVED_FIXTURE_BODY = `Hi {{first_name}},

You asked us to send you the contact information for contractors who work the
way you described. Here they are:

  {{name}} - {{phone}} - {{website}}
  {{name}} - {{phone}} - {{website}}
  {{name}} - {{phone}} - {{website}}

We make no representation about these companies' licensing, insurance, work or
pricing, and we are not a party to anything you do with them. We are sending
their contact information because you asked for it.

If you change your mind and would rather have contractors compete for your
project, you can come back any time: https://otterquote.com/start

This is a one-time message. We will not email you again unless you ask.

- The Otter Quotes team`;

const THREE = [
  { name: "Acme Roofing", phone: "317-555-0101", website: "acmeroofing.example" },
  { name: "Best Gutters", phone: "317-555-0102", website: "bestgutters.example" },
  { name: "Cedar Siding Co", phone: "317-555-0103", website: "cedarsiding.example" },
];

Deno.test("approved subject and body template are byte-identical to the approved string (#2019 comment 5731910268)", () => {
  assertEquals(APPROVED_SUBJECT, APPROVED_FIXTURE_SUBJECT);
  assertEquals(APPROVED_BODY_TEMPLATE, APPROVED_FIXTURE_BODY);
});

Deno.test("GOLDEN (a) normal name: full subject, text and HTML", () => {
  const out = renderReferralOutEmail("Jane", THREE);
  assertEquals(out.subject, "The contractors you asked for");
  assertEquals(
    out.text,
    `Hi Jane,

You asked us to send you the contact information for contractors who work the
way you described. Here they are:

  Acme Roofing - 317-555-0101 - acmeroofing.example
  Best Gutters - 317-555-0102 - bestgutters.example
  Cedar Siding Co - 317-555-0103 - cedarsiding.example

We make no representation about these companies' licensing, insurance, work or
pricing, and we are not a party to anything you do with them. We are sending
their contact information because you asked for it.

If you change your mind and would rather have contractors compete for your
project, you can come back any time: https://otterquote.com/start

This is a one-time message. We will not email you again unless you ask.

- The Otter Quotes team

${ADDR}`,
  );
  assertEquals(
    out.html,
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1E293B;"><div style="white-space:pre-wrap;">Hi Jane,

You asked us to send you the contact information for contractors who work the
way you described. Here they are:

  Acme Roofing - 317-555-0101 - acmeroofing.example
  Best Gutters - 317-555-0102 - bestgutters.example
  Cedar Siding Co - 317-555-0103 - cedarsiding.example

We make no representation about these companies' licensing, insurance, work or
pricing, and we are not a party to anything you do with them. We are sending
their contact information because you asked for it.

If you change your mind and would rather have contractors compete for your
project, you can come back any time: https://otterquote.com/start

This is a one-time message. We will not email you again unless you ask.

- The Otter Quotes team</div><div style="margin-top:24px;font-size:12px;color:#64748B;"><div style="margin-top:6px;">${ADDR}</div></div></div>`,
  );
});

Deno.test("GOLDEN (b) name needing HTML escaping plus CR/LF: text stripped only, HTML stripped and escaped", () => {
  const name = "Ann <b>\"O'Neil\" & Co</b>\r\nBcc: x@y.z";
  const contractors = [
    { name: "A&B <Roofing>", phone: "317-555-0101", website: "a-b.example/?q=1&r=2" },
    { name: "Best\r\nGutters", phone: "317-555-0102", website: "bestgutters.example" },
    THREE[2],
  ];
  const out = renderReferralOutEmail(name, contractors);
  assertEquals(out.subject, "The contractors you asked for");
  assertEquals(
    out.text,
    `Hi Ann <b>"O'Neil" & Co</b>Bcc: x@y.z,

You asked us to send you the contact information for contractors who work the
way you described. Here they are:

  A&B <Roofing> - 317-555-0101 - a-b.example/?q=1&r=2
  BestGutters - 317-555-0102 - bestgutters.example
  Cedar Siding Co - 317-555-0103 - cedarsiding.example

We make no representation about these companies' licensing, insurance, work or
pricing, and we are not a party to anything you do with them. We are sending
their contact information because you asked for it.

If you change your mind and would rather have contractors compete for your
project, you can come back any time: https://otterquote.com/start

This is a one-time message. We will not email you again unless you ask.

- The Otter Quotes team

${ADDR}`,
  );
  assertEquals(
    out.html,
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1E293B;"><div style="white-space:pre-wrap;">Hi Ann &lt;b&gt;&quot;O'Neil&quot; &amp; Co&lt;/b&gt;Bcc: x@y.z,

You asked us to send you the contact information for contractors who work the
way you described. Here they are:

  A&amp;B &lt;Roofing&gt; - 317-555-0101 - a-b.example/?q=1&amp;r=2
  BestGutters - 317-555-0102 - bestgutters.example
  Cedar Siding Co - 317-555-0103 - cedarsiding.example

We make no representation about these companies' licensing, insurance, work or
pricing, and we are not a party to anything you do with them. We are sending
their contact information because you asked for it.

If you change your mind and would rather have contractors compete for your
project, you can come back any time: https://otterquote.com/start

This is a one-time message. We will not email you again unless you ask.

- The Otter Quotes team</div><div style="margin-top:24px;font-size:12px;color:#64748B;"><div style="margin-top:6px;">${ADDR}</div></div></div>`,
  );
});

Deno.test("name is inserted VERBATIM: no trimming, no first-token parsing, no re-substitution of placeholder text", () => {
  assertEquals(renderReferralOutEmail("Dr. Mary Ann Smith", THREE).text.split("\n")[0], "Hi Dr. Mary Ann Smith,");
  assertEquals(renderReferralOutEmail("  Jane  ", THREE).text.split("\n")[0], "Hi   Jane  ,");
  // A value containing another placeholder is inserted literally, never expanded.
  assertEquals(renderReferralOutEmail("{{phone}}", THREE).text.split("\n")[0], "Hi {{phone}},");
});

Deno.test("GOLDEN (c) blank names: isBlankName, no render, and the alert says 'no name captured'", () => {
  for (const blank of ["", " ", "   ", "\t", "\r\n", " \r\n\t ", null, undefined, 42]) {
    assertEquals(isBlankName(blank), true, `blank=${JSON.stringify(blank)}`);
    assertThrows(() => renderReferralOutEmail(blank as string, THREE), Error, "blank name");
  }
  assertEquals(isBlankName("J"), false);
  assertEquals(isBlankName("  J "), false);

  const alert = buildNoNameAlert({ id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" });
  assertEquals(alert.subject, "[OtterQuote] Referral-out request: no name captured");
  assertEquals(
    alert.text,
    `A referral-out request (D-324) could not be answered: no name captured.
Lead id : 11111111-1111-4111-8111-111111111111
Email   : jane@example.com

No name captured: the approved D-324 email was NOT sent to this requester (it opens with their name and no fallback greeting exists). Follow up by hand.`,
  );
  assertEquals(
    alert.html,
    `<p style="font-family:sans-serif;font-size:14px;">A referral-out request (D-324) could not be answered: no name captured.</p><p style="font-family:sans-serif;font-size:14px;">Lead id: 11111111-1111-4111-8111-111111111111<br>Email: jane@example.com</p><p style="font-family:sans-serif;font-size:12px;color:#94A3B8;">No name captured: the approved D-324 email was NOT sent to this requester (it opens with their name and no fallback greeting exists). Follow up by hand.</p>`,
  );
});

Deno.test("renderReferralOutEmail requires exactly three contractors", () => {
  assertThrows(() => renderReferralOutEmail("Jane", THREE.slice(0, 2)), Error, "exactly three");
  assertThrows(() => renderReferralOutEmail("Jane", [...THREE, THREE[0]]), Error, "exactly three");
});

Deno.test("no D-104 trigger word appears anywhere in the rendered email (approved copy carries none)", () => {
  const out = renderReferralOutEmail("Jane", THREE);
  for (const w of ["vetted", "approved", "endorsed", "certified", "screened", "verified", "recommend"]) {
    assertEquals(new RegExp(w, "i").test(out.subject + out.text + out.html), false, w);
  }
});

Deno.test("drift guards: the no-name note and the variant marker match notify-admin-new-homeowner's copies", () => {
  assertEquals(REFERRAL_OUT_NO_NAME_NOTE, NOTIFY_NO_NAME_NOTE);
  assertEquals(REFERRAL_OUT_VARIANT, NOTIFY_VARIANT);
  assertEquals(REFERRAL_OUT_VARIANT, "e-referral-out");
});
