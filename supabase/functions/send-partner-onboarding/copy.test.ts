// Deno unit tests for gh-2154 P-4 placeholder-copy module.
// Run: deno test supabase/functions/send-partner-onboarding/copy.test.ts

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  composeFinalCopy,
  getCopyForAgentType,
  getUnsubscribeLineTemplate,
  hasPlaceholderCopy,
  OPT_OUT_URL_TOKEN,
  PLACEHOLDER_MARKER,
} from "./copy.ts";
import type { OnboardingStage } from "./onboarding-stage.ts";

const STAGES: OnboardingStage[] = ["day0", "day1", "day3", "day7"];

Deno.test("every eligible agent_type x stage combination has copy, and it is placeholder copy", () => {
  for (const agentType of ["re_agent", "insurance_agent", "home_inspector"]) {
    for (const stage of STAGES) {
      const copy = getCopyForAgentType(agentType, stage);
      assertNotEquals(copy, null, `${agentType}/${stage} should have copy`);
      assertEquals(hasPlaceholderCopy(copy!), true, `${agentType}/${stage} should still be placeholder`);
    }
  }
});

Deno.test("ineligible / unknown agent_type gets no copy at all", () => {
  for (const agentType of ["customer", "adjuster", "other", "bogus", null, undefined]) {
    for (const stage of STAGES) {
      assertEquals(getCopyForAgentType(agentType as string | null, stage), null);
    }
  }
});

Deno.test("hasPlaceholderCopy is true if the marker is in subject OR text OR html", () => {
  const clean = { subject: "Welcome", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  assertEquals(hasPlaceholderCopy(clean), false);
  assertEquals(hasPlaceholderCopy({ ...clean, subject: `Welcome ${PLACEHOLDER_MARKER}x]]` }), true);
  assertEquals(hasPlaceholderCopy({ ...clean, textBody: `${PLACEHOLDER_MARKER}x]]` }), true);
  assertEquals(hasPlaceholderCopy({ ...clean, htmlBody: `<p>${PLACEHOLDER_MARKER}x]]</p>` }), true);
});

Deno.test("real (filled-in) copy with no bracket marker anywhere is NOT placeholder", () => {
  const real = {
    subject: "Welcome to OtterQuote — let's get you set up",
    textBody: "Hi there, thanks for joining as a partner.",
    htmlBody: "<p>Hi there, thanks for joining as a partner.</p>",
  };
  assertEquals(hasPlaceholderCopy(real), false);
});

// ── Kevin correction Q1: unsubscribe line ───────────────────────────────────

Deno.test("unsubscribe template is still placeholder today, and mentions the {{optOutUrl}} token", () => {
  const tmpl = getUnsubscribeLineTemplate();
  assertEquals(tmpl.includes(PLACEHOLDER_MARKER), true);
  assertEquals(tmpl.includes(OPT_OUT_URL_TOKEN), true);
});

Deno.test("composeFinalCopy with placeholder unsubscribe copy: still hasPlaceholderCopy (blocks sending)", () => {
  const base = { subject: "Welcome", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  const final = composeFinalCopy(base, "https://otterquote.com/functions/v1/partner-email-optout?t=abc.def", "");
  assertEquals(hasPlaceholderCopy(final), true);
});

Deno.test("composeFinalCopy applies the [TEST] prefix to the subject only", () => {
  const base = { subject: "Welcome", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "[TEST] ");
  assertEquals(final.subject, "[TEST] Welcome");
});

Deno.test("once real (non-placeholder) unsubscribe copy is used, composeFinalCopy renders the real per-partner link in BOTH bodies and clears the placeholder gate", () => {
  const base = { subject: "Welcome", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  const optOutUrl = "https://otterquote.com/functions/v1/partner-email-optout?t=signed.token123";
  const realTemplate = `Stop these emails any time: ${OPT_OUT_URL_TOKEN}`;
  const final = composeFinalCopy(base, optOutUrl, "", realTemplate);
  assertEquals(final.textBody.includes(optOutUrl), true);
  assertEquals(final.htmlBody.includes(optOutUrl), true);
  assertEquals(hasPlaceholderCopy(final), false);
});
