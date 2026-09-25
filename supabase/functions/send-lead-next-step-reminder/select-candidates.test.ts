// Deno unit tests for gh-2121 (LRS HO-1 S21) lead next-step reminder
// selection logic. Run: deno test supabase/functions/send-lead-next-step-reminder/select-candidates.test.ts
//
// These are the FAIL-FIRST tests: select-candidates.ts does not exist on
// main, so every test below fails with a module-not-found error before this
// PR's files are added, and passes after.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type CandidateLead,
  dedupeByNormalizedEmail,
  normalizeEmailKey,
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
    role: "homeowner",
    variant: "f",
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

// ── Fix round 1 (CEO RUN 68 REVIEW: FAIL / LEGAL-READ: FAIL) ────────────────
// These fail against head 0a4988fe: `role`/`variant` did not exist on
// CandidateLead, `invalid_email_format` was not a SkipReason, and
// dedupeByNormalizedEmail / normalizeEmailKey did not exist at all.

// -- must-fix 6: HO-1 / Arm F scope only --

Deno.test("skips a contractor-role lead (adversarial test A5 scope)", () => {
  const lead = baseLead({ role: "contractor" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "not_homeowner_arm_f" });
});

Deno.test("skips a referral_partner-role lead", () => {
  const lead = baseLead({ role: "referral_partner" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "not_homeowner_arm_f" });
});

Deno.test("skips a homeowner lead from a different arm (variant != 'f')", () => {
  const lead = baseLead({ variant: "a" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "not_homeowner_arm_f" });
});

Deno.test("skips a homeowner Arm F lead whose variant is NULL (unset arm, not yet Arm F)", () => {
  const lead = baseLead({ variant: null });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "not_homeowner_arm_f" });
});

Deno.test("sends for role='homeowner' AND variant='f' (in-scope)", () => {
  const lead = baseLead({ role: "homeowner", variant: "f" });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

// -- must-fix 5: strict single-address validation (adversarial test A6) --

Deno.test("skips a comma-separated email list", () => {
  const lead = baseLead({ email: "victim@gmail.com,attacker@evil.example" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "invalid_email_format" });
});

Deno.test("skips a semicolon-separated email list", () => {
  const lead = baseLead({ email: "victim@gmail.com;attacker@evil.example" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "invalid_email_format" });
});

Deno.test("skips a display-name email form", () => {
  const lead = baseLead({ email: "Jane Doe <jane@gmail.com>" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "invalid_email_format" });
});

Deno.test("skips an email containing embedded whitespace", () => {
  const lead = baseLead({ email: "jane doe@gmail.com" });
  assertEquals(selectLeadForReminder(lead, true, NOW), { send: false, skip_reason: "invalid_email_format" });
});

Deno.test("does not flag a normal single address as invalid format", () => {
  const lead = baseLead({ email: "jane.doe+home@gmail.com" });
  assertEquals(selectLeadForReminder(lead, true, NOW).send, true);
});

// -- must-fix 4: normalizeEmailKey / dedupeByNormalizedEmail --

Deno.test("normalizeEmailKey lowercases and trims", () => {
  assertEquals(normalizeEmailKey("  Jane@Gmail.com  "), "jane@gmail.com");
});

Deno.test("dedupeByNormalizedEmail keeps the first occurrence per address (adversarial test A7)", () => {
  const rows = [
    { id: "a", email: "victim@gmail.com" },
    { id: "b", email: "Victim@Gmail.com" }, // same address, different case
    { id: "c", email: "other@gmail.com" },
    { id: "d", email: " victim@gmail.com " }, // same address, whitespace
  ];
  const { toSend, duplicates } = dedupeByNormalizedEmail(rows);
  assertEquals(toSend.map((r) => r.id), ["a", "c"]);
  assertEquals(duplicates.map((r) => r.id), ["b", "d"]);
});

Deno.test("dedupeByNormalizedEmail lets a null/blank email through untouched (not its concern)", () => {
  const rows = [
    { id: "a", email: null },
    { id: "b", email: "" },
    { id: "c", email: "real@gmail.com" },
  ];
  const { toSend, duplicates } = dedupeByNormalizedEmail(rows);
  assertEquals(toSend.map((r) => r.id), ["a", "b", "c"]);
  assertEquals(duplicates.length, 0);
});
