// Deno unit tests for the #856 partner referral status email templates.
// Run: deno test supabase/functions/send-partner-status-email/templates.test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  formatReferralDisplayName,
  isStageBlockedForAgentType,
  renderStageEmail,
  STAGE_KEYS,
  type Stage,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

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

// ── isStageBlockedForAgentType — D-333 gate (Ben's ruling, CEO RUN 67) ─────
// PR #2158 re-review (comments 5818774175 / 5818776287): the SQL trigger's
// own skip (v116) only covers the catch-up call it makes itself. The real
// completion path is mark-job-complete calling send-partner-status-email
// directly, which only ever skipped agent_type='customer' (D-303). D-333
// says a home_inspector referrer earns no referral fee or recruit bonus, so
// stage 5's "payment is on its way" copy is a false promise to them —
// gating it inside this function is the one place every sender goes
// through, per Ben's ruling.
//
// "Fail first" negative control (documents the pre-fix defect this test
// guards against): before this gate existed, isStageBlockedForAgentType did
// not exist at all, so nothing stopped stage 5 from being considered
// eligible-and-unsent for a home_inspector and rendered/sent exactly like
// any other agent_type — see REVIEW comments 5818774175 / 5818776287, which
// reproduced that live behavior against production (email=1 for an
// inspector referral pre-fix, in the "LIVE (control)" block).

Deno.test("D-333: stage 5 is blocked for home_inspector", () => {
  assertEquals(isStageBlockedForAgentType("home_inspector", 5), true);
});

Deno.test("D-333 control: stage 5 is NOT blocked for re_agent (still sends)", () => {
  assertEquals(isStageBlockedForAgentType("re_agent", 5), false);
});

Deno.test("D-333 control: stage 3 is NOT blocked for home_inspector (still sends)", () => {
  assertEquals(isStageBlockedForAgentType("home_inspector", 3), false);
});

Deno.test("D-333: stages 1, 2 and 4 are never blocked for home_inspector — no payment language there", () => {
  for (const stage of [1, 2, 4] as Stage[]) {
    assertEquals(isStageBlockedForAgentType("home_inspector", stage), false);
  }
});

Deno.test("D-333: null/undefined/other agent_type never blocks any stage", () => {
  for (const stage of ALL_STAGES) {
    assertEquals(isStageBlockedForAgentType(null, stage), false);
    assertEquals(isStageBlockedForAgentType(undefined, stage), false);
    assertEquals(isStageBlockedForAgentType("customer", stage), false);
  }
});

// ── gh-1824: D-237 postal-address footer, actually rendered ──────────────
// PR #2197's independent review (comment 5839071861, finding 2) proved a
// prior version of this fix could have its footer call silently deleted
// from the email builder with nothing here catching it -- these two
// functions only asserted the *constant's* value, never what
// renderStageEmail() actually produces. These assertions render every
// stage and check the address is genuinely present in BOTH bodies.

Deno.test("gh-1824: every stage's HTML carries the D-237 postal address", () => {
  for (const stage of ALL_STAGES) {
    const { html } = renderStageEmail(stage, "Jane D.");
    assertStringIncludes(html, POSTAL_ADDRESS);
  }
});

Deno.test("gh-1824: every stage's plain text carries the D-237 postal address", () => {
  for (const stage of ALL_STAGES) {
    const { text } = renderStageEmail(stage, "Jane D.");
    assertStringIncludes(text, POSTAL_ADDRESS);
  }
});

Deno.test("gh-1824 negative control: renderStageEmail's text is NOT merely the un-suffixed body -- the address must be a real suffix, not incidentally present", () => {
  // If a future edit stops appending the address, this assertion is what
  // catches it: text.length strictly grows by the address (+ separator)
  // versus what the internal, unexported body-only renderer would produce
  // alone. We can't import renderStageEmailBody (not exported, by design --
  // see templates.ts), so instead assert structurally: text must END with
  // the exact address string, which only the gh-1824 suffix step can do.
  for (const stage of ALL_STAGES) {
    const { text } = renderStageEmail(stage, "Jane D.");
    assertEquals(text.endsWith(POSTAL_ADDRESS), true);
  }
});
