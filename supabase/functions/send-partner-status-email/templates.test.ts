// Deno unit tests for the #856 partner referral status email templates.
// Run: deno test supabase/functions/send-partner-status-email/templates.test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  formatReferralDisplayName,
  renderStageEmail,
  STAGE_KEYS,
  type Stage,
} from "./templates.ts";

const ALL_STAGES: Stage[] = [1, 2, 3, 4, 5];
const DASHBOARD_URL = "https://otterquote.com/partner-dashboard.html";

// ── formatReferralDisplayName — privacy scope (#856 AC) ───────────────────

Deno.test("full name collapses to first name + last initial", () => {
  assertEquals(formatReferralDisplayName("Jane Doe"), "Jane D.");
});

Deno.test("multi-word name uses first token + final token's initial", () => {
  assertEquals(formatReferralDisplayName("Mary Jane Watson"), "Mary W.");
});

Deno.test("single-word name is kept as-is", () => {
  assertEquals(formatReferralDisplayName("Jane"), "Jane");
});

Deno.test("null/empty name falls back to 'your referral'", () => {
  assertEquals(formatReferralDisplayName(null), "your referral");
  assertEquals(formatReferralDisplayName(undefined), "your referral");
  assertEquals(formatReferralDisplayName("   "), "your referral");
});

// ── renderStageEmail — all 5 stages ────────────────────────────────────────

Deno.test("all 5 stages are defined in STAGE_KEYS", () => {
  assertEquals(Object.keys(STAGE_KEYS).length, 5);
});

for (const stage of ALL_STAGES) {
  Deno.test(`stage ${stage}: renders non-empty subject, html, and text`, () => {
    const rendered = renderStageEmail(stage, "Jane D.");
    assert(rendered.subject.length > 0, "subject must not be empty");
    assert(rendered.html.length > 0, "html must not be empty");
    assert(rendered.text.length > 0, "text must not be empty");
  });

  Deno.test(`stage ${stage}: html has a button (#869) — never a bare URL in a <p>`, () => {
    const { html } = renderStageEmail(stage, "Jane D.");
    // The dashboard URL must only ever appear inside an href= attribute in
    // the HTML part — never as bare visible text.
    assertStringIncludes(html, `href="${DASHBOARD_URL}"`);
    // MSO VML conditional present (#869 AC1 — Outlook fallback).
    assertStringIncludes(html, "v:roundrect");
    assertStringIncludes(html, "<!--[if mso]>");
  });

  Deno.test(`stage ${stage}: text part keeps the bare URL (#869 AC2)`, () => {
    const { text } = renderStageEmail(stage, "Jane D.");
    assertStringIncludes(text, DASHBOARD_URL);
  });

  Deno.test(`stage ${stage}: mentions the referral's display name`, () => {
    const { html, text } = renderStageEmail(stage, "Jane D.");
    assertStringIncludes(html, "Jane D.");
    assertStringIncludes(text, "Jane D.");
  });

  Deno.test(`stage ${stage}: privacy — no dollar amounts, no contractor name field`, () => {
    const { html, text } = renderStageEmail(stage, "Jane D.");
    assert(!html.includes("$"), "html must not contain a dollar amount");
    assert(!text.includes("$"), "text must not contain a dollar amount");
  });

  Deno.test(`stage ${stage}: no payout-timing duration language (#850 class guard)`, () => {
    const { html, text } = renderStageEmail(stage, "Jane D.");
    const durationRe =
      /\b\d+\s*(?:[-–]\s*\d+\s*)?(?:business\s+)?(?:day|days|week|weeks)\b/i;
    assert(!durationRe.test(html), `html for stage ${stage} must not contain a duration`);
    assert(!durationRe.test(text), `text for stage ${stage} must not contain a duration`);
  });
}

Deno.test("stage 5 is the only stage that mentions payment, and states no interval", () => {
  for (const stage of ALL_STAGES) {
    const { html, text } = renderStageEmail(stage, "Jane D.");
    const mentionsPayment = /payment/i.test(html) || /payment/i.test(text);
    if (stage === 5) {
      assert(mentionsPayment, "stage 5 must mention payment");
      assertStringIncludes(html, "payment is on its way");
      // Explicitly must NOT commit to an interval.
      assert(
        !/within \d/i.test(html) && !/\d+\s*(?:business\s+)?days?/i.test(html),
        "stage 5 must not state a payment interval",
      );
    } else {
      assert(!mentionsPayment, `stage ${stage} must not mention payment`);
    }
  }
});

Deno.test("each stage has distinct subject and headline copy", () => {
  const subjects = ALL_STAGES.map((s) => renderStageEmail(s, "Jane D.").subject);
  assertEquals(new Set(subjects).size, subjects.length);
});
