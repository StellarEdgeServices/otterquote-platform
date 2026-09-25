// Deno unit tests for gh-2121 (LRS HO-1 S21) lead next-step reminder
// selection logic. Run: deno test supabase/functions/send-lead-next-step-reminder/select-candidates.test.ts
//
// These are the FAIL-FIRST tests: select-candidates.ts does not exist on
// main, so every test below fails with a module-not-found error before this
// PR's files are added, and passes after.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type CandidateLead,
  REMINDER_MIN_AGE_MS,
  selectLeadForReminder,
} from "./select-candidates.ts";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const H = 60 * 60 * 1000;

function baseLead(overrides: Partial<CandidateLead> = {}): CandidateLead {
  return {
    id: "lead-1",
    email: "homeowner@gmail.com",
    created_at: new Date(NOW - 25 * H).toISOString(), // just over 24h old
    is_synthetic: null,
    next_step_reminder_sent_at: null,
    next_step_reminder_opted_out_at: null,
    has_goal_event: false,
    ...overrides,
  };
}

// ── Positive: an eligible lead sends ────────────────────────────────────────

Deno.test("selects a lead >24h old, no goal, has email, switch ON", () => {
  const decision = selectLeadForReminder(baseLead(), true, NOW);
  assertEquals(decision, { send: true });
});

Deno.test("exactly at the 24h boundary is eligible", () => {
  const lead = baseLead({ created_at: new Date(NOW - REMINDER_MIN_AGE_MS).toISOString() });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

Deno.test("just under 24h old is NOT eligible (too_young)", () => {
  const lead = baseLead({ created_at: new Date(NOW - REMINDER_MIN_AGE_MS + 1).toISOString() });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "too_young" });
});

Deno.test("older than the max age window is NOT eligible (too_old)", () => {
  const lead = baseLead({ created_at: new Date(NOW - 8 * 24 * H).toISOString() });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "too_old" });
});

// ── Kill switch: OFF sends nothing, regardless of eligibility ──────────────

Deno.test("switch OFF sends nothing, even for an otherwise-perfect candidate", () => {
  const decision = selectLeadForReminder(baseLead(), false, NOW);
  assertEquals(decision, { send: false, skip_reason: "disabled" });
});

Deno.test("switch OFF is checked before every other predicate (garbage lead still 'disabled')", () => {
  const garbage = baseLead({ email: null, is_synthetic: true, has_goal_event: true });
  assertEquals(selectLeadForReminder(garbage, false, NOW).skip_reason, "disabled");
});

// ── Skip: goal recorded ─────────────────────────────────────────────────────

Deno.test("skips a lead with a goal event recorded", () => {
  const lead = baseLead({ has_goal_event: true });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "goal_recorded" });
});

// ── Skip: synthetic ──────────────────────────────────────────────────────

Deno.test("skips a synthetic lead (is_synthetic = true)", () => {
  const lead = baseLead({ is_synthetic: true });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "synthetic_lead" });
});

Deno.test("a NULL is_synthetic is NOT treated as synthetic", () => {
  const lead = baseLead({ is_synthetic: null });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

Deno.test("is_synthetic = false is NOT treated as synthetic", () => {
  const lead = baseLead({ is_synthetic: false });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

// ── Skip: no email ──────────────────────────────────────────────────────

Deno.test("skips a lead with no email", () => {
  const lead = baseLead({ email: null });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "no_email" });
});

Deno.test("skips a lead with a blank email", () => {
  const lead = baseLead({ email: "   " });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "no_email" });
});

// ── Skip: founder/test address ──────────────────────────────────────────

Deno.test("skips a founder/internal address (@otterquote.com)", () => {
  const lead = baseLead({ email: "dustin@otterquote.com" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "founder_or_test_email" });
});

Deno.test("skips the leads-specific reserved test suffix", () => {
  const lead = baseLead({ email: "qa@otterquote-internal.test" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "founder_or_test_email" });
});

Deno.test("does NOT skip a real address that merely contains 'test'", () => {
  const lead = baseLead({ email: "protest@gmail.com" });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

// ── Skip: already sent ──────────────────────────────────────────────────

Deno.test("skips a lead already sent (idempotent — sent at most once)", () => {
  const lead = baseLead({ next_step_reminder_sent_at: new Date(NOW - H).toISOString() });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "already_sent" });
});

// ── Skip: opted out ──────────────────────────────────────────────────────

Deno.test("skips a lead that has opted out (D-320-style)", () => {
  const lead = baseLead({ next_step_reminder_opted_out_at: new Date(NOW - H).toISOString() });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "opted_out" });
});

// ── Order of checks: kill switch first, then email/founder/synthetic before
// the opt-out/sent/goal/age checks that require reading more of the row —
// mirrors the send-homeowner-next-steps screenClaim() ordering rule that
// "an opted-out claim must cost no reads" is about the DB layer, not this
// pure function's own branch order, but the disabled-first guarantee below
// is this module's own load-bearing order fact.

Deno.test("malformed created_at fails closed (too_young, never a crash)", () => {
  const lead = baseLead({ created_at: "not-a-date" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "too_young" });
});
