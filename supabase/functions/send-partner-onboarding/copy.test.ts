// Deno unit tests for gh-2154 P-4's onboarding copy module.
// Run: deno test supabase/functions/send-partner-onboarding/copy.test.ts
//
// The exact-text assertions below transcribe the DUSTIN-APPROVED copy
// (issue #2154 comment 5821400303, footer/address per 5825271438, approval
// per 5832299333) — they exist specifically to fail on the pre-copy base
// (792acb33, where every cell is a `[[...]]` placeholder) and pass once the
// approved words are wired in verbatim.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  composeFinalCopy,
  getCopyForAgentType,
  getUnsubscribeLineTemplate,
  hasPlaceholderCopy,
  INSTALL_APP_URL,
  OPT_OUT_URL_TOKEN,
  PARTNER_APP_SIGNIN_URL,
  PLACEHOLDER_MARKER,
  resolveFirstName,
} from "./copy.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";
import type { OnboardingStage } from "./onboarding-stage.ts";

const STAGES: OnboardingStage[] = ["day0", "day1", "day3", "day7"];
const AGENT_TYPES = ["re_agent", "insurance_agent", "home_inspector"] as const;

// ── Approved copy landed: no cell is a placeholder any more ────────────────

Deno.test("every eligible agent_type x stage combination has copy, and it is NOT placeholder copy", () => {
  for (const agentType of AGENT_TYPES) {
    for (const stage of STAGES) {
      const copy = getCopyForAgentType(agentType, stage);
      assertNotEquals(copy, null, `${agentType}/${stage} should have copy`);
      assertEquals(hasPlaceholderCopy(copy!), false, `${agentType}/${stage} should be real (approved) copy, not placeholder`);
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

// ── Exact approved subjects (5821400303, unchanged by Dustin's ruling) ─────

Deno.test("re_agent subjects match 5821400303 verbatim", () => {
  assertEquals(getCopyForAgentType("re_agent", "day0")!.subject, "Your Otter Quotes partner account is ready");
  assertEquals(getCopyForAgentType("re_agent", "day1")!.subject, "One step left: sign in inside the app");
  assertEquals(getCopyForAgentType("re_agent", "day3")!.subject, "Your referral link is one sign-in away");
  assertEquals(getCopyForAgentType("re_agent", "day7")!.subject, "Last reminder: activate your Otter Quotes account");
});

Deno.test("insurance_agent subjects match 5821400303 verbatim (identical to re_agent set)", () => {
  assertEquals(getCopyForAgentType("insurance_agent", "day0")!.subject, "Your Otter Quotes partner account is ready");
  assertEquals(getCopyForAgentType("insurance_agent", "day1")!.subject, "One step left: sign in inside the app");
  assertEquals(getCopyForAgentType("insurance_agent", "day3")!.subject, "Your referral link is one sign-in away");
  assertEquals(getCopyForAgentType("insurance_agent", "day7")!.subject, "Last reminder: activate your Otter Quotes account");
});

Deno.test("home_inspector subjects match 5821400303 verbatim (day3 wording differs: 'Your link', not 'Your referral link')", () => {
  assertEquals(getCopyForAgentType("home_inspector", "day0")!.subject, "Your Otter Quotes partner account is ready");
  assertEquals(getCopyForAgentType("home_inspector", "day1")!.subject, "One step left: sign in inside the app");
  assertEquals(getCopyForAgentType("home_inspector", "day3")!.subject, "Your link is one sign-in away");
  assertEquals(getCopyForAgentType("home_inspector", "day7")!.subject, "Last reminder: activate your Otter Quotes account");
});

// ── Dustin's ruling: "Day 7 keeps 'last automated reminder'" ───────────────

Deno.test("every agent_type's day7 body keeps the exact phrase 'this is the last automated reminder' (Dustin's ruling, 5832299333)", () => {
  for (const agentType of AGENT_TYPES) {
    const copy = getCopyForAgentType(agentType, "day7")!;
    assertEquals(copy.textBody.includes("this is the last automated reminder"), true, `${agentType} day7 body`);
  }
});

// ── Fee language: present for re_agent/insurance_agent, ABSENT for
// home_inspector (D-333, 5821400303's own instruction for Set 3) ───────────

Deno.test("re_agent and insurance_agent copy carries the $200 fee line on day0/day1/day7 (not day3, per the approved copy)", () => {
  for (const agentType of ["re_agent", "insurance_agent"] as const) {
    for (const stage of ["day0", "day1", "day7"] as const) {
      const copy = getCopyForAgentType(agentType, stage)!;
      assertEquals(
        copy.textBody.includes("$200"),
        true,
        `${agentType}/${stage} should carry the $200 fee disclosure`,
      );
    }
  }
});

Deno.test("home_inspector copy NEVER mentions a dollar figure or 'fee' (D-333 — no fee/earnings language in Set 3)", () => {
  for (const stage of STAGES) {
    const copy = getCopyForAgentType("home_inspector", stage)!;
    assertEquals(copy.textBody.includes("$"), false, `home_inspector/${stage} textBody must not mention money`);
    assertEquals(/\bfee\b/i.test(copy.textBody), false, `home_inspector/${stage} textBody must not mention "fee"`);
  }
});

Deno.test("brand name used in copy is 'Otter Quotes', never 'OtterQuote' (D-175)", () => {
  for (const agentType of AGENT_TYPES) {
    for (const stage of STAGES) {
      const copy = getCopyForAgentType(agentType, stage)!;
      assertEquals(/OtterQuote(?!s)/.test(copy.textBody), false, `${agentType}/${stage} must not say "OtterQuote" without the s`);
    }
  }
});

// ── CTA destinations (5821400303 "Shared mechanics") ───────────────────────

Deno.test("day0 and day3 CTAs point at the install URL; day1 and day7 CTAs point at the sign-in URL", () => {
  for (const agentType of AGENT_TYPES) {
    assertEquals(getCopyForAgentType(agentType, "day0")!.htmlBody.includes(INSTALL_APP_URL), true);
    assertEquals(getCopyForAgentType(agentType, "day3")!.htmlBody.includes(INSTALL_APP_URL), true);
    assertEquals(getCopyForAgentType(agentType, "day1")!.htmlBody.includes(PARTNER_APP_SIGNIN_URL), true);
    assertEquals(getCopyForAgentType(agentType, "day7")!.htmlBody.includes(PARTNER_APP_SIGNIN_URL), true);
  }
});

// ── {{first_name}} merge field ──────────────────────────────────────────────

Deno.test("resolveFirstName falls back to 'there' for null/undefined/blank, otherwise trims", () => {
  assertEquals(resolveFirstName(null), "there");
  assertEquals(resolveFirstName(undefined), "there");
  assertEquals(resolveFirstName(""), "there");
  assertEquals(resolveFirstName("   "), "there");
  assertEquals(resolveFirstName("  Pat  "), "Pat");
});

Deno.test("composeFinalCopy substitutes {{first_name}} in both bodies with the resolved name", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "", undefined, "Pat");
  assertEquals(final.textBody.includes("Hi Pat,"), true);
  assertEquals(final.textBody.includes("{{first_name}}"), false);
  assertEquals(final.htmlBody.includes("{{first_name}}"), false);
});

Deno.test("composeFinalCopy falls back to 'there' when first_name is missing", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "", undefined, null);
  assertEquals(final.textBody.includes("Hi there,"), true);
});

Deno.test("composeFinalCopy HTML-escapes a hostile first_name before it reaches htmlBody", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const hostile = '<img src=x onerror=alert(1)>';
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "", undefined, hostile);
  assertEquals(final.htmlBody.includes("<img src=x onerror=alert(1)>"), false);
  assertEquals(final.htmlBody.includes("&lt;img"), true);
  // Plain text remains exempt from escaping (Ben's ruling).
  assertEquals(final.textBody.includes(hostile), true);
});

// ── CAN-SPAM footer / unsubscribe line (5821400303 shared mechanics,
// address per 5825271438) ───────────────────────────────────────────────────

Deno.test("the unsubscribe/footer template is real copy (not placeholder) and still carries the {{optOutUrl}} token", () => {
  const tmpl = getUnsubscribeLineTemplate();
  assertEquals(tmpl.includes(PLACEHOLDER_MARKER), false);
  assertEquals(tmpl.includes(OPT_OUT_URL_TOKEN), true);
});

Deno.test("the footer template matches 5821400303's shared-mechanics block verbatim, with D-237's POSTAL_ADDRESS in place of the mailing-address gap (5825271438)", () => {
  const tmpl = getUnsubscribeLineTemplate();
  assertEquals(
    tmpl.includes("Otter Quotes is a service of Stellar Edge Services LLC. You're receiving this because you signed up as an Otter Quotes referral partner."),
    true,
  );
  assertEquals(tmpl.includes(POSTAL_ADDRESS), true);
  assertEquals(tmpl.includes("[MAILING ADDRESS"), false, "the bracket placeholder from 5821400303 must be gone");
  assertEquals(tmpl.includes("Questions? Reply to this email or contact support@otterquote.com / (317) 501-9215."), true);
});

Deno.test("composeFinalCopy renders the real per-partner unsubscribe link, with the D-237 address, in BOTH bodies, and clears the placeholder gate", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const optOutUrl = "https://otterquote.com/functions/v1/partner-email-optout?t=signed.token123";
  const final = composeFinalCopy(base, optOutUrl, "", undefined, "Pat");
  assertEquals(final.textBody.includes(optOutUrl), true);
  assertEquals(final.htmlBody.includes(optOutUrl), true);
  assertEquals(final.textBody.includes(POSTAL_ADDRESS), true);
  assertEquals(final.htmlBody.includes(POSTAL_ADDRESS), true);
  assertEquals(hasPlaceholderCopy(final), false);
});

Deno.test("composeFinalCopy applies the [TEST] prefix to the subject only", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "[TEST] ", undefined, "Pat");
  assertEquals(final.subject, "[TEST] Your Otter Quotes partner account is ready");
});

// ── Kept from the pre-approval test suite (still-valid safety-net checks) ──

Deno.test("hasPlaceholderCopy is true if the marker is in subject OR text OR html", () => {
  const clean = { subject: "Welcome", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  assertEquals(hasPlaceholderCopy(clean), false);
  assertEquals(hasPlaceholderCopy({ ...clean, subject: `Welcome ${PLACEHOLDER_MARKER}x]]` }), true);
  assertEquals(hasPlaceholderCopy({ ...clean, textBody: `${PLACEHOLDER_MARKER}x]]` }), true);
  assertEquals(hasPlaceholderCopy({ ...clean, htmlBody: `<p>${PLACEHOLDER_MARKER}x]]</p>` }), true);
});

Deno.test("real (filled-in) copy with no bracket marker anywhere is NOT placeholder", () => {
  const real = {
    subject: "Welcome to Otter Quotes — let's get you set up",
    textBody: "Hi there, thanks for joining as a partner.",
    htmlBody: "<p>Hi there, thanks for joining as a partner.</p>",
  };
  assertEquals(hasPlaceholderCopy(real), false);
});

// ── PR #2162 review 5822537570 (gh-2154 P-4): the same rule applied to P-3's
// notify-admin-new-partner -- HTML-escape every dynamic value that
// composeFinalCopy interpolates into htmlBody, and never let raw CR/LF reach
// an email header (the subject). Re-verified here against the real copy
// (previously only proven against a synthetic base).
Deno.test("(escape) composeFinalCopy HTML-escapes a hostile opt-out URL substituted into the HTML body, not the text body", () => {
  const base = getCopyForAgentType("re_agent", "day0")!;
  const hostileOptOutUrl = 'https://x/optout?t=<img src=x onerror=alert(1)>&r="><script>alert(2)</script>';
  const final = composeFinalCopy(base, hostileOptOutUrl, "", undefined, "Pat");

  assertEquals(final.htmlBody.includes("<img src=x onerror=alert(1)>"), false);
  assertEquals(final.htmlBody.includes("<script>alert(2)</script>"), false);
  assertEquals(final.htmlBody.includes("&lt;img"), true);
  assertEquals(final.htmlBody.includes("&lt;script&gt;"), true);

  // Plain-text body is exempt from escaping per Ben's ruling -- the raw URL
  // (still click/copy-able) is expected there, unescaped.
  assertEquals(final.textBody.includes(hostileOptOutUrl), true);
});

Deno.test("(escape) composeFinalCopy strips CR/LF from the composed subject (header injection)", () => {
  const base = { subject: "Welcome\r\nBcc: evil@example.com", textBody: "Hello", htmlBody: "<p>Hello</p>" };
  const final = composeFinalCopy(base, "https://x/optout?t=abc", "[TEST] \n", undefined, "Pat");

  assertEquals(final.subject.includes("\r"), false);
  assertEquals(final.subject.includes("\n"), false);
});
