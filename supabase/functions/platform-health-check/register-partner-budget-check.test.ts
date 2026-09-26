// Deno unit tests for gh-2223's register_partner_global budget-alert rule
// (PR #2237 REVIEW:FAIL 5850688286, defect D2).
// Run: deno test supabase/functions/platform-health-check/register-partner-budget-check.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { evaluateRegisterPartnerGlobalBudget } from "./register-partner-budget-check.ts";

const LIMITS = { maxPerHour: 120, maxPerDay: 500 };

Deno.test("evaluateRegisterPartnerGlobalBudget: below every threshold returns null", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 10, dayCount: 100 }, LIMITS);
  assertEquals(result, null);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: at 80% of daily returns a warning", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 10, dayCount: 400 }, LIMITS);
  assertEquals(result?.alertType, "rate_limit_global_warning");
  assertEquals(result?.functionName, "register_partner");
});

Deno.test("evaluateRegisterPartnerGlobalBudget: just under 80% of daily returns null", () => {
  // ceil(500*0.8) = 400 -- 399 must NOT warn yet.
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 10, dayCount: 399 }, LIMITS);
  assertEquals(result, null);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: at 100% of daily returns exhausted, not warning", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 10, dayCount: 500 }, LIMITS);
  assertEquals(result?.alertType, "rate_limit_global_exhausted");
  assertEquals(result?.message.includes("24h"), true);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: at 100% of HOURLY returns exhausted even if daily is nowhere near it (the case D2 called out)", () => {
  // At 120/hr the global bucket already refuses real signups long before
  // 500/day is anywhere close -- REVIEW FAIL 5850688286 D2: "today's
  // reconciler only watches the daily count" was the exact gap this fixes.
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 120, dayCount: 120 }, LIMITS);
  assertEquals(result?.alertType, "rate_limit_global_exhausted");
  assertEquals(result?.message.includes("hour"), true);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: hourly exhaustion takes priority over a simultaneous daily warning", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 120, dayCount: 450 }, LIMITS);
  assertEquals(result?.alertType, "rate_limit_global_exhausted");
  assertEquals(result?.message.includes("hour"), true);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: daily exhaustion takes priority over the 80% warning band", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 5, dayCount: 501 }, LIMITS);
  assertEquals(result?.alertType, "rate_limit_global_exhausted");
  assertEquals(result?.message.includes("24h"), true);
});

Deno.test("evaluateRegisterPartnerGlobalBudget: a zero/negative limit is treated as unconfigured (no alert, never throws)", () => {
  const result = evaluateRegisterPartnerGlobalBudget({ hourCount: 999, dayCount: 999 }, { maxPerHour: 0, maxPerDay: 0 });
  assertEquals(result, null);
});
