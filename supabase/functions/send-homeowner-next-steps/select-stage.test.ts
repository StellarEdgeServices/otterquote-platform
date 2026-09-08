// Deno unit tests for gh-1580 nudge selection + stage logic (CTO RUN 22 defects).
// Run: deno test supabase/functions/send-homeowner-next-steps/select-stage.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type ActivityLogRow,
  FORTY_EIGHT_HOURS_MS,
  isNudgeEligibleStatus,
  type NudgeStage,
  reduceActivityRows,
  screenClaim,
  selectStage,
  STAGE_GAP_MS,
  TWO_HOURS_MS,
} from "./select-stage.ts";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T21:00:00Z");
const claimAged = (ageMs: number) => ({ id: "c1", created_at: new Date(NOW - ageMs).toISOString() });
const sends = (entries: [NudgeStage, number][]) =>
  new Map<NudgeStage, string>(entries.map(([s, ago]) => [s, new Date(NOW - ago).toISOString()]));
const none = new Map<NudgeStage, string>();

// ── Defect 1: status predicate ───────────────────────────────────────────────

Deno.test("documents_needed is the only eligible status", () => {
  assertEquals(isNudgeEligibleStatus("documents_needed"), true);
});

Deno.test("draft is explicitly excluded (RUN 22: Dustin's own draft claim was targeted)", () => {
  assertEquals(isNudgeEligibleStatus("draft"), false);
});

Deno.test("every other status in the gh-1532 CHECK set is excluded", () => {
  for (const s of ["submitted", "active", "waitlisted", "bidding", "contract_signed", "awarded"]) {
    assertEquals(isNudgeEligibleStatus(s), false, s);
  }
  assertEquals(isNudgeEligibleStatus(null), false);
  assertEquals(isNudgeEligibleStatus(undefined), false);
  assertEquals(isNudgeEligibleStatus(""), false);
});

// ── Defect 2: one email per run, stage 2 depends on stage 1 record ──────────

Deno.test("younger than 2h: nothing", () => {
  assertEquals(selectStage(claimAged(1 * H), none, NOW), null);
  assertEquals(selectStage(claimAged(TWO_HOURS_MS - 1), none, NOW), null);
});

Deno.test("2h <= age < 48h, nothing recorded: '2h' only", () => {
  assertEquals(selectStage(claimAged(TWO_HOURS_MS), none, NOW), "2h");
  assertEquals(selectStage(claimAged(44.7 * H), none, NOW), "2h"); // George Milberger's shape at RUN 23
  assertEquals(selectStage(claimAged(FORTY_EIGHT_HOURS_MS - 1), none, NOW), "2h");
});

Deno.test("first-run backlog (age >= 48h, nothing recorded): exactly ONE email, the '48h' stage — never both", () => {
  assertEquals(selectStage(claimAged(FORTY_EIGHT_HOURS_MS), none, NOW), "48h");
  assertEquals(selectStage(claimAged(211.7 * H), none, NOW), "48h");
  assertEquals(selectStage(claimAged(752 * H), none, NOW), "48h"); // the 2026-08-04 backlog claim
});

Deno.test("backlog claim after its single '48h' send: never emailed again (no '2h' back-fill)", () => {
  assertEquals(selectStage(claimAged(753 * H), sends([["48h", 1 * H]]), NOW), null);
  assertEquals(selectStage(claimAged(900 * H), sends([["48h", 148 * H]]), NOW), null);
});

Deno.test("'2h' recorded but claim < 48h old: nothing (stage 2 waits for the age gate)", () => {
  assertEquals(selectStage(claimAged(10 * H), sends([["2h", 8 * H]]), NOW), null);
  assertEquals(selectStage(claimAged(FORTY_EIGHT_HOURS_MS - 1), sends([["2h", 45 * H]]), NOW), null);
});

Deno.test("steady state: '2h' stamped at ~+2h, claim now 48h old -> '48h'", () => {
  // stamp landed 46h ago (claim was 2h old), claim is now 48h old
  assertEquals(selectStage(claimAged(FORTY_EIGHT_HOURS_MS), sends([["2h", STAGE_GAP_MS]]), NOW), "48h");
  assertEquals(selectStage(claimAged(50 * H), sends([["2h", 47 * H]]), NOW), "48h");
});

Deno.test("'2h' stamped recently on an old claim: '48h' waits until the stamp is >= 46h old (no 3-hours-apart double)", () => {
  // e.g. George: first seen at 44.7h -> '2h' sent; at 48h the stamp is only 3.3h old
  assertEquals(selectStage(claimAged(48 * H), sends([["2h", 3.3 * H]]), NOW), null);
  assertEquals(selectStage(claimAged(90 * H), sends([["2h", STAGE_GAP_MS - 1]]), NOW), null);
  assertEquals(selectStage(claimAged(90.7 * H), sends([["2h", STAGE_GAP_MS]]), NOW), "48h");
});

Deno.test("'48h' recorded: terminal, nothing more regardless of '2h'", () => {
  assertEquals(selectStage(claimAged(100 * H), sends([["2h", 98 * H], ["48h", 52 * H]]), NOW), null);
  assertEquals(selectStage(claimAged(100 * H), sends([["48h", 52 * H]]), NOW), null);
});

Deno.test("never returns more than one stage per call (property over an age sweep)", () => {
  for (let age = 0; age <= 800 * H; age += 0.5 * H) {
    for (const prior of [none, sends([["2h", Math.min(age, 46 * H)]]), sends([["48h", 1 * H]])]) {
      const r = selectStage(claimAged(age), prior, NOW);
      assertEquals(r === null || r === "2h" || r === "48h", true);
    }
  }
});

Deno.test("a full simulated hourly cron over a fresh claim sends exactly '2h' then '48h', once each", () => {
  const created = NOW;
  const stamps = new Map<NudgeStage, string>();
  const sent: { stage: NudgeStage; atH: number }[] = [];
  for (let h = 0; h <= 200; h++) {
    const t = created + h * H;
    const stage = selectStage({ id: "c", created_at: new Date(created).toISOString() }, stamps, t);
    if (stage) {
      stamps.set(stage, new Date(t).toISOString());
      sent.push({ stage, atH: h });
    }
  }
  assertEquals(sent, [{ stage: "2h", atH: 2 }, { stage: "48h", atH: 48 }]);
});

Deno.test("a full simulated hourly cron over a first-run backlog claim (age 752h) sends exactly one email ever", () => {
  const created = NOW - 752 * H;
  const stamps = new Map<NudgeStage, string>();
  const sent: NudgeStage[] = [];
  for (let h = 0; h <= 200; h++) {
    const t = NOW + h * H;
    const stage = selectStage({ id: "c", created_at: new Date(created).toISOString() }, stamps, t);
    if (stage) {
      stamps.set(stage, new Date(t).toISOString());
      sent.push(stage);
    }
  }
  assertEquals(sent, ["48h"]);
});

Deno.test("malformed timestamps fail closed", () => {
  assertEquals(selectStage({ id: "c", created_at: "not-a-date" }, none, NOW), null);
  assertEquals(selectStage(claimAged(100 * H), new Map([["2h", "garbage"]]), NOW), null);
});

// ── gh-1580 acceptance test (CTO RUN 28, comment 5572642959) ────────────────
//
// "seed one is_test homeowner claim at documents_needed with zero
//  activity_log rows and zero hover_orders, invoke send-homeowner-next-steps
//  by hand, and assert EXACTLY ONE activity_log row with
//  event_type = 'next_steps_nudge_sent'; then add a single activity_log row
//  to that claim, invoke again, and assert ZERO further nudges."
//
// Both halves, on the real screen index.ts calls. The second half is the one
// that can fail: a screen that nudges a claim which has since moved is #1786's
// defect made worse, and a strip that pins every new claim is not a detector.

const NUDGE_EVENT = "next_steps_nudge_sent";
const OPTOUT_EVENT = "homeowner_nudge_opt_out";
const USER = "u-homeowner-1";
const CLAIM = "claim-1";

const seededClaim = (ageMs: number, status = "documents_needed") => ({
  id: CLAIM,
  user_id: USER,
  status,
  created_at: new Date(NOW - ageMs).toISOString(),
});

const screen = (
  claim: ReturnType<typeof seededClaim>,
  rows: ActivityLogRow[],
  opts: { optedOut?: string[]; hover?: string[] } = {},
) =>
  screenClaim(claim, {
    optedOutClaimIds: new Set(opts.optedOut ?? []),
    claimIdsWithHoverOrder: new Set(opts.hover ?? []),
    reduced: reduceActivityRows(rows, NUDGE_EVENT, OPTOUT_EVENT),
    now: NOW,
  });

const nudgeStamp = (stage: NudgeStage, ago: number): ActivityLogRow => ({
  user_id: USER,
  event_type: NUDGE_EVENT,
  metadata: { claim_id: CLAIM, nudge_stage: stage },
  created_at: new Date(NOW - ago).toISOString(),
});

const realRow = (ago: number, type = "claim_documents_uploaded"): ActivityLogRow => ({
  user_id: USER,
  event_type: type,
  metadata: null,
  created_at: new Date(NOW - ago).toISOString(),
});

Deno.test("ACCEPTANCE half 1 — zero activity_log rows, zero hover_orders, 2h old: EXACTLY ONE nudge, stage '2h'", () => {
  const d = screen(seededClaim(3 * H), []);
  assertEquals(d.stage, "2h");
  assertEquals(d.skipped_reason, undefined);
});

Deno.test("ACCEPTANCE half 2 — ONE real activity_log row after signup: ZERO further nudges (the discriminating half)", () => {
  const d = screen(seededClaim(3 * H), [realRow(1 * H)]);
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "real_activity_since_created");
});

Deno.test("half 2 still holds at 48h+ — a claim that moved is never back-filled with the '48h' email either", () => {
  const d = screen(seededClaim(200 * H), [realRow(150 * H)]);
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "real_activity_since_created");
});

Deno.test("NEGATIVE CONTROL — activity BEFORE the claim existed does not disqualify it (a screen that skips everything is not a screen)", () => {
  // 5h-old claim, an activity row from before it was created (a prior claim
  // by the same homeowner). The handler's predicate is lastReal > created_at.
  const d = screen(seededClaim(5 * H), [realRow(9 * H)]);
  assertEquals(d.stage, "2h");
  assertEquals(d.skipped_reason, undefined);
});

Deno.test("our OWN nudge stamp is not 'real activity' — otherwise the '2h' send would disqualify its own '48h' follow-up", () => {
  const d = screen(seededClaim(50 * H), [nudgeStamp("2h", 48 * H)]);
  assertEquals(d.skipped_reason, undefined);
  assertEquals(d.stage, "48h");
});

Deno.test("gh-1786 — an opt-out row is not 'real activity' and never looks like homeowner progress", () => {
  const optOutRow: ActivityLogRow = {
    user_id: USER,
    event_type: OPTOUT_EVENT,
    metadata: { claim_id: CLAIM },
    created_at: new Date(NOW - 1 * H).toISOString(),
  };
  // Not counted as movement...
  const reduced = reduceActivityRows([optOutRow], NUDGE_EVENT, OPTOUT_EVENT);
  assertEquals(reduced.realActivityByUser.size, 0);
  // ...and the claim is screened out by the opt-out gate, not by activity.
  const d = screen(seededClaim(3 * H), [optOutRow], { optedOut: [CLAIM] });
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "opted_out");
});

Deno.test("gate order — opt-out is decided before hover_orders and before stage selection", () => {
  const d = screen(seededClaim(3 * H), [], { optedOut: [CLAIM], hover: [CLAIM] });
  assertEquals(d.skipped_reason, "opted_out");
});

Deno.test("a hover_orders row disqualifies the claim (it took the paid path, not the stalled one)", () => {
  const d = screen(seededClaim(3 * H), [], { hover: [CLAIM] });
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "has_hover_order");
});

Deno.test("status gate survives the extraction — a draft is screened out before anything else", () => {
  assertEquals(screen(seededClaim(3 * H, "draft"), []).skipped_reason, "ineligible_status");
  assertEquals(screen(seededClaim(3 * H, "bidding"), []).skipped_reason, "ineligible_status");
});

Deno.test("duplicate stamps for one stage: the EARLIEST wins (pre-#1725 race must not delay the '48h' send)", () => {
  const reduced = reduceActivityRows(
    [nudgeStamp("2h", 10 * H), nudgeStamp("2h", 48 * H)],
    NUDGE_EVENT,
    OPTOUT_EVENT,
  );
  assertEquals(
    reduced.nudgeSentByClaim.get(CLAIM)?.get("2h"),
    new Date(NOW - 48 * H).toISOString(),
  );
});

Deno.test("a nudge stamp carrying no claim_id / an unknown stage is ignored rather than trusted", () => {
  const rows: ActivityLogRow[] = [
    { user_id: USER, event_type: NUDGE_EVENT, metadata: { nudge_stage: "2h" }, created_at: new Date(NOW).toISOString() },
    { user_id: USER, event_type: NUDGE_EVENT, metadata: { claim_id: CLAIM, nudge_stage: "9h" }, created_at: new Date(NOW).toISOString() },
  ];
  const reduced = reduceActivityRows(rows, NUDGE_EVENT, OPTOUT_EVENT);
  assertEquals(reduced.nudgeSentByClaim.size, 0);
  assertEquals(reduced.realActivityByUser.size, 0); // and they are not "real activity" either
});

Deno.test("the full acceptance sequence, run as the cron would: nudge, then movement, then silence forever", () => {
  const created = NOW;
  const rows: ActivityLogRow[] = [];
  const sent: { stage: NudgeStage; atH: number }[] = [];
  for (let h = 0; h <= 200; h++) {
    const t = created + h * H;
    // The homeowner uploads one document at h=10 — real movement.
    if (h === 10) rows.push({ ...realRow(0), created_at: new Date(t).toISOString() });
    const d = screenClaim(
      { id: CLAIM, user_id: USER, status: "documents_needed", created_at: new Date(created).toISOString() },
      {
        optedOutClaimIds: new Set<string>(),
        claimIdsWithHoverOrder: new Set<string>(),
        reduced: reduceActivityRows(rows, NUDGE_EVENT, OPTOUT_EVENT),
        now: t,
      },
    );
    if (d.stage) {
      sent.push({ stage: d.stage, atH: h });
      rows.push({
        user_id: USER,
        event_type: NUDGE_EVENT,
        metadata: { claim_id: CLAIM, nudge_stage: d.stage },
        created_at: new Date(t).toISOString(),
      });
    }
  }
  // Exactly one email: the '2h' at h=2. The h=10 upload stops the series —
  // the '48h' email that WOULD have gone at h=48 never does.
  assertEquals(sent, [{ stage: "2h", atH: 2 }]);
});
