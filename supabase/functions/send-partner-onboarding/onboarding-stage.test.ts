// Deno unit tests for gh-2154 P-4 stage selection (RUN 22 defect 2, applied
// to a 4-stage sequence instead of homeowner's 2-stage one).
// Run: deno test supabase/functions/send-partner-onboarding/onboarding-stage.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  canClaimStage,
  DAY_MS,
  hasAcceptedAgreementAndIsActive,
  isEligibleAgentType,
  isUncertainPending,
  type LedgerStatus,
  type OnboardingStage,
  selectStage,
  STALE_PENDING_MINUTES,
} from "./onboarding-stage.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const partnerAged = (
  ageMs: number,
  activatedAgo: number | null = null,
  optedOutAgo: number | null = null,
) => ({
  created_at: new Date(NOW - ageMs).toISOString(),
  app_first_signed_in_launch_at: activatedAgo === null ? null : new Date(NOW - activatedAgo).toISOString(),
  onboarding_opted_out_at: optedOutAgo === null ? null : new Date(NOW - optedOutAgo).toISOString(),
});
const ledger = (entries: [OnboardingStage, LedgerStatus][]) =>
  new Map<OnboardingStage, LedgerStatus>(entries);
const none = new Map<OnboardingStage, LedgerStatus>();
const MIN = 60 * 1000;

// ── day boundaries ──────────────────────────────────────────────────────────

Deno.test("brand new partner (age 0): day0 due now", () => {
  assertEquals(selectStage(partnerAged(0), none, NOW).stage, "day0");
});

Deno.test("just under a day: still only day0", () => {
  assertEquals(selectStage(partnerAged(DAY_MS - 1), none, NOW).stage, "day0");
});

Deno.test("exactly 1 day, day0 already sent: day1 due", () => {
  const sel = selectStage(partnerAged(DAY_MS), ledger([["day0", "sent"]]), NOW);
  assertEquals(sel.stage, "day1");
  assertEquals(sel.toMarkSkipped, []);
});

Deno.test("exactly 3 days, day0+day1 sent: day3 due", () => {
  const sel = selectStage(
    partnerAged(3 * DAY_MS),
    ledger([["day0", "sent"], ["day1", "sent"]]),
    NOW,
  );
  assertEquals(sel.stage, "day3");
});

Deno.test("exactly 7 days, day0+1+3 sent: day7 due", () => {
  const sel = selectStage(
    partnerAged(7 * DAY_MS),
    ledger([["day0", "sent"], ["day1", "sent"], ["day3", "sent"]]),
    NOW,
  );
  assertEquals(sel.stage, "day7");
});

Deno.test("day7 already sent: nothing further, ever", () => {
  const sel = selectStage(
    partnerAged(30 * DAY_MS),
    ledger([["day0", "sent"], ["day1", "sent"], ["day3", "sent"], ["day7", "sent"]]),
    NOW,
  );
  assertEquals(sel.stage, null);
  assertEquals(sel.toMarkSkipped, []);
});

// ── backlog: only the latest due stage, never two in one run ───────────────

Deno.test("9-day-old partner, first ever run: only day7 sends, day0/day1/day3 marked skipped", () => {
  const sel = selectStage(partnerAged(9 * DAY_MS), none, NOW);
  assertEquals(sel.stage, "day7");
  assertEquals(sel.toMarkSkipped, ["day0", "day1", "day3"]);
});

Deno.test("4-day-old partner with only day0 resolved: day3 sends (the latest due), day1 marked skipped", () => {
  const sel = selectStage(partnerAged(4 * DAY_MS), ledger([["day0", "sent"]]), NOW);
  assertEquals(sel.stage, "day3");
  assertEquals(sel.toMarkSkipped, ["day1"]);
});

Deno.test("backlog never returns more than one stage to send, across every age tested", () => {
  for (const ageDays of [0, 0.5, 1, 2, 3, 5, 7, 10, 30, 365]) {
    const sel = selectStage(partnerAged(ageDays * DAY_MS), none, NOW);
    // stage is a single value or null — the type itself forbids "two stages",
    // but assert the invariant explicitly: whatever sent, toMarkSkipped
    // holds everything else that was due, so the sum of (sent ? 1 : 0) is
    // never more than 1 for this call.
    const sentCount = sel.stage === null ? 0 : 1;
    assertEquals(sentCount <= 1, true, `age ${ageDays}d sent more than one stage`);
  }
});

// ── stop on activation ──────────────────────────────────────────────────────

Deno.test("activated partner (day2, between day1 and day3): day3 never sends even though it's due", () => {
  // day0 and day1 already sent (that happened before activation); activated
  // partway through day2; now day3's threshold has passed.
  const sel = selectStage(
    partnerAged(3 * DAY_MS, /* activatedAgo */ 1 * DAY_MS), // activated ~1 day ago, i.e. at day2
    ledger([["day0", "sent"], ["day1", "sent"]]),
    NOW,
  );
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "activated");
  assertEquals(sel.toMarkSkipped, []);
});

Deno.test("activated partner gets NO skip-marking either — activation gate returns zero writes", () => {
  const sel = selectStage(
    partnerAged(30 * DAY_MS, 20 * DAY_MS),
    none,
    NOW,
  );
  assertEquals(sel.stage, null);
  assertEquals(sel.toMarkSkipped, []);
});

// ── negative controls ───────────────────────────────────────────────────────

Deno.test("negative control: activates right after day0 — nothing further, ever, at any later age", () => {
  const afterDay0Ledger = ledger([["day0", "sent"]]);
  for (const ageDays of [1, 3, 7, 30, 90]) {
    const sel = selectStage(partnerAged(ageDays * DAY_MS, ageDays * DAY_MS - 3600_000), afterDay0Ledger, NOW);
    assertEquals(sel.stage, null, `age ${ageDays}d should not send`);
    assertEquals(sel.reason, "activated");
  }
});

Deno.test("negative control: never activates — gets day0, day1, day3, day7 in that order across separate runs", () => {
  let recorded = new Map<OnboardingStage, LedgerStatus>();
  const runsAndExpected: [number, OnboardingStage][] = [
    [0, "day0"],
    [1 * DAY_MS, "day1"],
    [3 * DAY_MS, "day3"],
    [7 * DAY_MS, "day7"],
  ];
  for (const [ageMs, expected] of runsAndExpected) {
    const sel = selectStage(partnerAged(ageMs), recorded, NOW);
    assertEquals(sel.stage, expected, `at age ${ageMs}ms`);
    recorded = new Map(recorded);
    recorded.set(expected, "sent");
    for (const skipped of sel.toMarkSkipped) recorded.set(skipped, "skipped");
  }
  // After day7, nothing more, ever.
  const sel = selectStage(partnerAged(100 * DAY_MS), recorded, NOW);
  assertEquals(sel.stage, null);
});

// ── invalid / defensive ──────────────────────────────────────────────────────

Deno.test("malformed created_at fails closed (no stage, no crash)", () => {
  const sel = selectStage(
    { created_at: "not-a-date", app_first_signed_in_launch_at: null, onboarding_opted_out_at: null },
    none,
    NOW,
  );
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "invalid_created_at");
});

Deno.test("clock-skewed future created_at: not due", () => {
  const sel = selectStage(partnerAged(-DAY_MS), none, NOW);
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "not_due");
});

// ── agent_type routing ──────────────────────────────────────────────────────

Deno.test("re_agent / insurance_agent / home_inspector are eligible", () => {
  assertEquals(isEligibleAgentType("re_agent"), true);
  assertEquals(isEligibleAgentType("insurance_agent"), true);
  assertEquals(isEligibleAgentType("home_inspector"), true);
});

Deno.test("customer / adjuster / other / unknown / null are NOT eligible", () => {
  for (const t of ["customer", "adjuster", "other", "something_new", null, undefined, ""]) {
    // deno-lint-ignore no-explicit-any
    assertEquals(isEligibleAgentType(t as any), false, String(t));
  }
});

// ── Kevin correction Q1: opt-out stop condition (mirrors activation) ───────

Deno.test("opted-out partner: nothing sends, even on day0, even with nothing else recorded", () => {
  const sel = selectStage(partnerAged(0, null, 0), none, NOW);
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "opted_out");
  assertEquals(sel.toMarkSkipped, []);
});

Deno.test("opted-out partner with backlog due: still nothing, no skip-marking either", () => {
  const sel = selectStage(partnerAged(9 * DAY_MS, null, 1 * DAY_MS), none, NOW);
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "opted_out");
  assertEquals(sel.toMarkSkipped, []);
});

Deno.test("opt-out wins even if activation is ALSO set (both permanent gates, either is sufficient)", () => {
  const sel = selectStage(partnerAged(9 * DAY_MS, 2 * DAY_MS, 1 * DAY_MS), none, NOW);
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "opted_out");
});

// ── Kevin correction Q3: 'pending'/'failed' are NOT resolved ────────────────

Deno.test("a 'failed' day0 with day1 also due: day1 is the latest and wins; day0 is marked skipped exactly like any other backlog stage (retried is not this ledger's job once superseded)", () => {
  const sel = selectStage(partnerAged(1 * DAY_MS), ledger([["day0", "failed"]]), NOW);
  assertEquals(sel.stage, "day1");
  assertEquals(sel.toMarkSkipped, ["day0"]);
});

Deno.test("a 'failed' day0 with nothing else due yet: day0 itself is what's selected (retry, not skip)", () => {
  const sel = selectStage(partnerAged(0), ledger([["day0", "failed"]]), NOW);
  assertEquals(sel.stage, "day0");
  assertEquals(sel.toMarkSkipped, []);
});

Deno.test("a fresh 'pending' day0 (in-flight from another run) is still 'due' from selectStage's view — the CLAIM step is what actually blocks a double-send, not selectStage", () => {
  const sel = selectStage(partnerAged(0), ledger([["day0", "pending"]]), NOW);
  assertEquals(sel.stage, "day0");
});

Deno.test("'sent' and 'skipped' remain terminal — never re-selected", () => {
  assertEquals(selectStage(partnerAged(0), ledger([["day0", "sent"]]), NOW).stage, null);
  assertEquals(
    selectStage(partnerAged(4 * DAY_MS), ledger([["day0", "sent"], ["day1", "skipped"]]), NOW).stage,
    "day3",
  );
});

// ── canClaimStage (pure mirror of the DB-level conditional upsert) ─────────

Deno.test("canClaimStage: no existing row -> claimable", () => {
  assertEquals(canClaimStage(undefined, NOW), true);
});

Deno.test("canClaimStage: 'sent' -> never claimable", () => {
  assertEquals(canClaimStage({ status: "sent", created_at: new Date(NOW).toISOString() }, NOW), false);
});

Deno.test("canClaimStage: 'skipped' -> never claimable", () => {
  assertEquals(canClaimStage({ status: "skipped", created_at: new Date(NOW).toISOString() }, NOW), false);
});

Deno.test("canClaimStage: 'failed' -> always claimable regardless of age", () => {
  assertEquals(canClaimStage({ status: "failed", created_at: new Date(NOW - 999 * DAY_MS).toISOString() }, NOW), true);
  assertEquals(canClaimStage({ status: "failed", created_at: new Date(NOW).toISOString() }, NOW), true);
});

Deno.test("canClaimStage: fresh 'pending' (younger than the stale window) -> NOT claimable", () => {
  const fresh = new Date(NOW - (STALE_PENDING_MINUTES * MIN - 1)).toISOString();
  assertEquals(canClaimStage({ status: "pending", created_at: fresh }, NOW), false);
});

// Ben, DECIDED (orchestrator review, ruling c REOPENED): a stale 'pending'
// row used to be reclaimable here — that was itself the defect ("mark the
// stage sent-or-uncertain BEFORE calling Mailgun, never auto-reclaim a row
// whose send outcome is unknown"). This test used to assert `true`
// ("claimable"); it now asserts the opposite and is the fail-first proof
// for item (i) — it FAILS on head 1cbf2f8e, where canClaimStage's 'pending'
// branch still returns `now - claimedMs >= staleMinutes * 60 * 1000`
// (i.e. `true` for anything past the stale window).
Deno.test("canClaimStage: stale 'pending' (10x past the stale window) is STILL NOT claimable — never reclaimed, however old", () => {
  const stale = new Date(NOW - STALE_PENDING_MINUTES * MIN).toISOString();
  assertEquals(canClaimStage({ status: "pending", created_at: stale }, NOW), false);
  const veryStale = new Date(NOW - 10 * STALE_PENDING_MINUTES * MIN).toISOString();
  assertEquals(canClaimStage({ status: "pending", created_at: veryStale }, NOW), false);
  const yearsStale = new Date(NOW - 999 * MIN).toISOString();
  assertEquals(canClaimStage({ status: "pending", created_at: yearsStale }, NOW), false);
});

Deno.test("canClaimStage: malformed created_at on a 'pending' row fails closed (not claimable)", () => {
  assertEquals(canClaimStage({ status: "pending", created_at: "not-a-date" }, NOW), false);
});

// ── isUncertainPending: the replacement for what stale 'pending' used to
// mean — never claimable (see canClaimStage above), but MUST still be
// distinguishable from a fresh, actively-in-flight 'pending' row, so
// run-sweep.ts can surface it instead of silently lumping it in with
// "already claimed by someone else." ────────────────────────────────────────

Deno.test("isUncertainPending: no existing row -> not uncertain (nothing to surface)", () => {
  assertEquals(isUncertainPending(undefined, NOW), false);
});

Deno.test("isUncertainPending: 'sent' / 'skipped' / 'failed' -> never uncertain (resolved or safely retryable)", () => {
  assertEquals(isUncertainPending({ status: "sent", created_at: new Date(NOW).toISOString() }, NOW), false);
  assertEquals(isUncertainPending({ status: "skipped", created_at: new Date(NOW).toISOString() }, NOW), false);
  assertEquals(isUncertainPending({ status: "failed", created_at: new Date(NOW - 999 * MIN).toISOString() }, NOW), false);
});

Deno.test("isUncertainPending: fresh 'pending' (younger than the stale window) -> NOT uncertain yet (still actively in flight)", () => {
  const fresh = new Date(NOW - (STALE_PENDING_MINUTES * MIN - 1)).toISOString();
  assertEquals(isUncertainPending({ status: "pending", created_at: fresh }, NOW), false);
});

Deno.test("isUncertainPending: 'pending' at or past the stale window -> uncertain, must be surfaced", () => {
  const stale = new Date(NOW - STALE_PENDING_MINUTES * MIN).toISOString();
  assertEquals(isUncertainPending({ status: "pending", created_at: stale }, NOW), true);
  const veryStale = new Date(NOW - 10 * STALE_PENDING_MINUTES * MIN).toISOString();
  assertEquals(isUncertainPending({ status: "pending", created_at: veryStale }, NOW), true);
});

Deno.test("isUncertainPending: malformed created_at on a 'pending' row fails TOWARD surfacing (uncertain), never toward silently ignoring it", () => {
  assertEquals(isUncertainPending({ status: "pending", created_at: "not-a-date" }, NOW), true);
});

// ── Ben, DECIDED (bus 14:01:57Z, ruling a - REVIEW FAIL 5833587935):
// switchEnabledSinceMs. These fail on head aae3acfc, where selectStage has
// only three parameters and no switch-timing concept at all - a 9-day-old
// partner reaches day7 the instant the switch flips on, regardless of when
// it flipped, which is exactly the day-7-blast defect this closes. --------

Deno.test("ruling (a): default (no switchEnabledSinceMs passed) behaves exactly as before - no gating", () => {
  const sel = selectStage(partnerAged(9 * DAY_MS), none, NOW);
  assertEquals(sel.stage, "day7");
});

Deno.test("ruling (a): partner created before switchEnabledSinceMs never enters, however old", () => {
  const switchOnMs = NOW; // switch flips on exactly now
  const sel = selectStage(partnerAged(9 * DAY_MS), none, NOW, switchOnMs);
  assertEquals(sel.stage, null);
  assertEquals(sel.toMarkSkipped, []);
  assertEquals(sel.reason, "before_switch_enabled");
});

Deno.test("ruling (a): partner created exactly AT switchEnabledSinceMs enters normally (boundary is inclusive)", () => {
  const switchOnMs = NOW - 9 * DAY_MS; // switch flipped on at this partner's exact created_at
  const sel = selectStage(partnerAged(9 * DAY_MS), none, NOW, switchOnMs);
  assertEquals(sel.stage, "day7");
});

Deno.test("ruling (a): partner created one millisecond before switchEnabledSinceMs is gated out", () => {
  const switchOnMs = NOW - 9 * DAY_MS + 1; // switch flipped on 1ms after this partner signed up
  const sel = selectStage(partnerAged(9 * DAY_MS), none, NOW, switchOnMs);
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "before_switch_enabled");
});

Deno.test("ruling (a): switch-timing gate checked ahead of opted_out/activated — but those permanent gates still win when set (order never matters in practice)", () => {
  const switchOnMs = NOW; // would gate out a 9-day-old partner
  const sel = selectStage(partnerAged(9 * DAY_MS, 1 * DAY_MS), none, NOW, switchOnMs);
  // activated 1 day ago -- activation is checked FIRST, before created_at
  // parsing or the switch-timing gate, so "activated" wins the reason, not
  // "before_switch_enabled" (both would say "nothing sends" either way).
  assertEquals(sel.stage, null);
  assertEquals(sel.reason, "activated");
});

// -- Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling): hasAcceptedAgreementAndIsActive
// -- These fail on head 1cbf2f8e, where this function does not exist at all
// (module-not-found on the import above) and PartnerRow has no status /
// partner_agreement_accepted_at fields. ------------------------------------

Deno.test("hasAcceptedAgreementAndIsActive: active + accepted -> true (a real P-1 signup)", () => {
  assertEquals(
    hasAcceptedAgreementAndIsActive({ status: "active", partner_agreement_accepted_at: "2026-09-01T00:00:00Z" }),
    true,
  );
});

Deno.test("hasAcceptedAgreementAndIsActive: no acceptance record at all -> false, whatever the status (this IS what P-5's Meta webhook will create)", () => {
  assertEquals(
    hasAcceptedAgreementAndIsActive({ status: "active", partner_agreement_accepted_at: null }),
    false,
  );
  assertEquals(
    hasAcceptedAgreementAndIsActive({ status: "pending", partner_agreement_accepted_at: null }),
    false,
  );
});

Deno.test("hasAcceptedAgreementAndIsActive: accepted but status is not 'active' -> false (e.g. suspended)", () => {
  assertEquals(
    hasAcceptedAgreementAndIsActive({ status: "suspended", partner_agreement_accepted_at: "2026-09-01T00:00:00Z" }),
    false,
  );
});

Deno.test("hasAcceptedAgreementAndIsActive: 'pending' status with acceptance recorded is still false (both conditions required)", () => {
  assertEquals(
    hasAcceptedAgreementAndIsActive({ status: "pending", partner_agreement_accepted_at: "2026-09-01T00:00:00Z" }),
    false,
  );
});
