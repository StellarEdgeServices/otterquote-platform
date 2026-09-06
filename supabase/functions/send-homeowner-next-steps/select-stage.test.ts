// Deno unit tests for gh-1580 nudge selection + stage logic (CTO RUN 22 defects).
// Run: deno test supabase/functions/send-homeowner-next-steps/select-stage.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  FORTY_EIGHT_HOURS_MS,
  isNudgeEligibleStatus,
  type NudgeStage,
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
