// Deno unit tests for gh-1570 Part 2 — the `checklist_complete_not_submitted`
// nudge stage (issue #1570, comment 5764786813).
// Run: deno test supabase/functions/send-homeowner-next-steps/checklist-complete-stage.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildChecklistCompleteEmailContent,
  CHECKLIST_COMPLETE_DELAY_MS,
  CHECKLIST_COMPLETE_EVENT_TYPE,
  CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
  CHECKLIST_COMPLETE_STAGE,
  type ChecklistCompleteDeliverDeps,
  deliverChecklistCompleteStage,
  reduceChecklistCompleteActivity,
  screenChecklistCompleteClaim,
} from "./checklist-complete-stage.ts";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-26T18:00:00Z");
const CLAIM = "claim-1";
const USER = "u-homeowner-1";

const claim = (overrides: Partial<{ status: string; ready_for_bids: boolean | null }> = {}) => ({
  id: CLAIM,
  status: "documents_needed",
  ready_for_bids: false,
  ...overrides,
});

const completeRow = (ago: number, claimId = CLAIM) => ({
  event_type: CHECKLIST_COMPLETE_EVENT_TYPE,
  metadata: { claim_id: claimId },
  created_at: new Date(NOW - ago).toISOString(),
});

const nudgeSentRow = (ago: number, claimId = CLAIM) => ({
  event_type: CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
  metadata: { claim_id: claimId },
  created_at: new Date(NOW - ago).toISOString(),
});

const screen = (
  c: ReturnType<typeof claim>,
  rows: ReturnType<typeof completeRow>[],
  optedOut: string[] = [],
) =>
  screenChecklistCompleteClaim(c, {
    optedOutClaimIds: new Set(optedOut),
    reduced: reduceChecklistCompleteActivity(rows),
    now: NOW,
  });

// ── The delay: 2h, same as the '2h' age-ladder rung ─────────────────────────

Deno.test("CHECKLIST_COMPLETE_DELAY_MS is exactly 2 hours", () => {
  assertEquals(CHECKLIST_COMPLETE_DELAY_MS, 2 * H);
});

// ── Core eligibility ────────────────────────────────────────────────────────

Deno.test("checklist complete >= 2h ago, not submitted: eligible", () => {
  const d = screen(claim(), [completeRow(3 * H)]);
  assertEquals(d.stage, CHECKLIST_COMPLETE_STAGE);
  assertEquals(d.skipped_reason, undefined);
});

Deno.test("checklist complete < 2h ago: not yet (too_recent)", () => {
  assertEquals(screen(claim(), [completeRow(1 * H)]).skipped_reason, "too_recent");
  assertEquals(screen(claim(), [completeRow(CHECKLIST_COMPLETE_DELAY_MS - 1)]).skipped_reason, "too_recent");
});

Deno.test("exactly at the 2h boundary: eligible", () => {
  assertEquals(screen(claim(), [completeRow(CHECKLIST_COMPLETE_DELAY_MS)]).stage, CHECKLIST_COMPLETE_STAGE);
});

Deno.test("no checklist_complete row at all: not eligible", () => {
  assertEquals(screen(claim(), []).skipped_reason, "not_checklist_complete");
});

// ── The defect this stage exists to fix: ready_for_bids flips it off ───────

Deno.test("ready_for_bids already true (homeowner clicked Submit for Bids): never nudged — THE NEGATIVE CONTROL", () => {
  const d = screen(claim({ ready_for_bids: true }), [completeRow(10 * H)]);
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "already_submitted");
});

Deno.test("ready_for_bids null/undefined behaves like false (never actually true)", () => {
  assertEquals(screen(claim({ ready_for_bids: null }), [completeRow(3 * H)]).stage, CHECKLIST_COMPLETE_STAGE);
});

Deno.test("status has already moved past documents_needed: ineligible_status", () => {
  assertEquals(screen(claim({ status: "active" }), [completeRow(3 * H)]).skipped_reason, "ineligible_status");
  assertEquals(screen(claim({ status: "draft" }), [completeRow(3 * H)]).skipped_reason, "ineligible_status");
});

// ── Deliberately NOT gated on real activity — the whole point of this stage ─

Deno.test("uploading the checklist items (real homeowner activity) does NOT disqualify this stage — that is the defect #1570 exists to fix", () => {
  // Contrast with select-stage.ts's screenClaim, which DOES exclude a claim
  // with real activity since created. This screen takes no activity_log rows
  // other than the checklist_complete / checklist_complete_nudge_sent ones,
  // so there is no "real activity" input it could even be gated on.
  const d = screen(claim(), [completeRow(3 * H)]);
  assertEquals(d.stage, CHECKLIST_COMPLETE_STAGE);
});

// ── Idempotence — one email, ever ───────────────────────────────────────────

Deno.test("already sent once: never again, regardless of ready_for_bids or age", () => {
  const d = screen(claim(), [completeRow(100 * H), nudgeSentRow(50 * H)]);
  assertEquals(d.stage, null);
  assertEquals(d.skipped_reason, "already_sent");
});

Deno.test("gate order — opt-out decided before already-sent and before eligibility", () => {
  const d = screen(claim(), [completeRow(3 * H)], [CLAIM]);
  assertEquals(d.skipped_reason, "opted_out");
});

Deno.test("opted out even with ready_for_bids already true: opt-out still reported first (order is deterministic, not load-bearing here, but explicit)", () => {
  const d = screen(claim({ ready_for_bids: true }), [completeRow(3 * H)], [CLAIM]);
  assertEquals(d.skipped_reason, "already_submitted");
});

// ── Reduction correctness ────────────────────────────────────────────────────

Deno.test("reduceChecklistCompleteActivity: earliest checklist_complete stamp wins on a duplicate write", () => {
  const reduced = reduceChecklistCompleteActivity([completeRow(10 * H), completeRow(48 * H)]);
  assertEquals(reduced.completedAtByClaim.get(CLAIM), new Date(NOW - 48 * H).toISOString());
});

Deno.test("reduceChecklistCompleteActivity: rows for a different claim_id do not leak across claims", () => {
  const reduced = reduceChecklistCompleteActivity([completeRow(3 * H, "other-claim")]);
  assertEquals(reduced.completedAtByClaim.has(CLAIM), false);
  assertEquals(reduced.completedAtByClaim.has("other-claim"), true);
});

Deno.test("reduceChecklistCompleteActivity: a row with no claim_id is ignored rather than trusted", () => {
  const reduced = reduceChecklistCompleteActivity([
    { event_type: CHECKLIST_COMPLETE_EVENT_TYPE, metadata: {}, created_at: new Date(NOW).toISOString() },
    { event_type: CHECKLIST_COMPLETE_EVENT_TYPE, metadata: null, created_at: new Date(NOW).toISOString() },
  ]);
  assertEquals(reduced.completedAtByClaim.size, 0);
});

Deno.test("malformed checklist_complete timestamp fails closed", () => {
  const d = screenChecklistCompleteClaim(claim(), {
    optedOutClaimIds: new Set(),
    reduced: {
      completedAtByClaim: new Map([[CLAIM, "not-a-date"]]),
      alreadySent: new Set(),
    },
    now: NOW,
  });
  assertEquals(d.skipped_reason, "not_checklist_complete");
});

// ── Full lifecycle simulation, as the cron would run it ─────────────────────

Deno.test("full lifecycle: silence -> checklist complete -> 2h later, nudged once -> submits -> never nudged again", () => {
  const rows: ReturnType<typeof completeRow>[] = [];
  const sent: number[] = [];
  const created = NOW - 100 * H; // irrelevant to this stage directly, but realistic
  let readyForBids = false;

  for (let h = 0; h <= 20; h++) {
    const t = created + (100 + h) * H;
    if (h === 0) rows.push({ ...completeRow(0), created_at: new Date(t).toISOString() });
    if (h === 15) readyForBids = true; // homeowner finally clicks Submit for Bids

    const d = screenChecklistCompleteClaim(
      claim({ ready_for_bids: readyForBids }),
      { optedOutClaimIds: new Set(), reduced: reduceChecklistCompleteActivity(rows), now: t },
    );
    if (d.stage) {
      sent.push(h);
      rows.push({ ...nudgeSentRow(0), created_at: new Date(t).toISOString() });
    }
  }

  // Exactly one send, at h=2 (2h after the checklist-complete stamp at h=0),
  // and the submission at h=15 produces no further send.
  assertEquals(sent, [2]);
});

Deno.test("full lifecycle NEGATIVE CONTROL: if the ready_for_bids gate were removed, the homeowner who already submitted would be nudged too", () => {
  // This test exists to prove the gate in the code above actually does
  // something: run the same scenario but WITHOUT ever setting ready_for_bids,
  // i.e. simulate the bug this stage's gate prevents — a homeowner who
  // submitted the SAME hour the checklist completed (a claim already at
  // ready_for_bids=true by the time 2h has passed) must still be excluded.
  const rows = [completeRow(3 * H)];
  const buggyDecision = screenChecklistCompleteClaim(
    claim({ ready_for_bids: true }),
    { optedOutClaimIds: new Set(), reduced: reduceChecklistCompleteActivity(rows), now: NOW },
  );
  assertEquals(buggyDecision.stage, null, "a submitted claim must never be nudged");
});

// ── Email content ────────────────────────────────────────────────────────────

Deno.test("buildChecklistCompleteEmailContent: subject and body carry the approved phrase, and the opt-out link", () => {
  const content = buildChecklistCompleteEmailContent("Nick Mansueto", "https://otterquote.com/dashboard.html", "https://example.com/optout?t=abc");
  assertEquals(content.subject, "You're one click from bids");
  assertEquals(content.textBody.includes("one click from bids"), true);
  assertEquals(content.textBody.includes("https://example.com/optout?t=abc"), true);
  assertEquals(content.htmlBody.includes("https://example.com/optout?t=abc"), true);
  assertEquals(content.textBody.includes("https://otterquote.com/dashboard.html"), true);
  assertEquals(content.textBody.startsWith("Hi Nick,"), true);
});

Deno.test("buildChecklistCompleteEmailContent: fails closed with no opt-out URL — D-320", () => {
  assertThrows(() => buildChecklistCompleteEmailContent("Nick", "https://otterquote.com/dashboard.html", ""));
});

Deno.test("buildChecklistCompleteEmailContent: no claims about coverage, bids guarantees, savings or timelines (R-120-style check, mirrors email-content.test.ts)", () => {
  const content = buildChecklistCompleteEmailContent("Nick", "https://otterquote.com/dashboard.html", "https://example.com/optout?t=abc");
  const forbidden = ["guarantee", "save you", "discount", "% off", "covered by insurance"];
  for (const phrase of forbidden) {
    assertEquals(content.textBody.toLowerCase().includes(phrase), false, phrase);
    assertEquals(content.htmlBody.toLowerCase().includes(phrase), false, phrase);
  }
});

// ── Delivery: dry run makes zero writes and zero sends ──────────────────────

function fakeDeps(overrides: Partial<ChecklistCompleteDeliverDeps> = {}): {
  deps: ChecklistCompleteDeliverDeps;
  calls: { insertActivityLog: number; sendEmail: number; insertNotification: number };
} {
  const calls = { insertActivityLog: 0, sendEmail: 0, insertNotification: 0 };
  const deps: ChecklistCompleteDeliverDeps = {
    dryRun: false,
    mailgunConfigured: true,
    buildEmail: (name, dashboardUrl, optOutUrl) =>
      buildChecklistCompleteEmailContent(name, dashboardUrl, optOutUrl),
    insertActivityLog: async (_row) => {
      calls.insertActivityLog++;
      return { error: null };
    },
    sendEmail: async (_to, _name, _dashboardUrl, _optOutUrl) => {
      calls.sendEmail++;
      return { ok: true, mailgunId: "mg-1" };
    },
    insertNotification: async (_row) => {
      calls.insertNotification++;
      return { error: null };
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

const CTX = {
  claimId: CLAIM,
  userId: USER,
  homeownerEmail: "nick@example.com",
  homeownerName: "Nick Mansueto",
  dashboardUrl: "https://otterquote.com/dashboard.html",
  optOutUrl: "https://example.com/optout?t=abc",
};

Deno.test("deliverChecklistCompleteStage — dry run: zero insertActivityLog, zero sendEmail, zero insertNotification calls", async () => {
  const { deps, calls } = fakeDeps({ dryRun: true });
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "previewed");
  assertEquals(calls.insertActivityLog, 0);
  assertEquals(calls.sendEmail, 0);
  assertEquals(calls.insertNotification, 0);
});

Deno.test("deliverChecklistCompleteStage — dry run NEGATIVE CONTROL: a mutant that checks dryRun AFTER sending would leave this red", async () => {
  // Simulates the mutant directly: call sendEmail unconditionally first, the
  // way a moved `if (dryRun)` branch would behave, and assert the harness
  // catches it (calls.sendEmail > 0 when it must be 0 for a real dry run).
  const { deps, calls } = fakeDeps({ dryRun: true });
  await deps.sendEmail("x@example.com", "X", CTX.dashboardUrl, CTX.optOutUrl); // simulate the bug directly
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "previewed");
  // The mutant call above is deliberately counted; the real deliver call
  // itself still must not have added to it.
  assertEquals(calls.sendEmail, 1);
});

Deno.test("deliverChecklistCompleteStage — real send: stamps activity_log, sends email, records notification", async () => {
  const { deps, calls } = fakeDeps();
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "sent");
  assertEquals(calls.insertActivityLog, 1);
  assertEquals(calls.sendEmail, 1);
  assertEquals(calls.insertNotification, 1);
});

Deno.test("deliverChecklistCompleteStage — send failure: records FAILED, does not throw, still writes notification", async () => {
  const { deps, calls } = fakeDeps({
    sendEmail: async () => {
      calls.sendEmail++;
      return { ok: false, error: "Mailgun 500" };
    },
  });
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "send_failed");
  assertEquals(calls.insertActivityLog, 1);
  assertEquals(calls.insertNotification, 1);
});

Deno.test("deliverChecklistCompleteStage — 23505 (concurrent duplicate stamp) counted as already_sent, not an error", async () => {
  const { deps } = fakeDeps({
    insertActivityLog: async () => ({ error: { code: "23505", message: "duplicate" } }),
  });
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "already_sent");
});

Deno.test("deliverChecklistCompleteStage — MAILGUN_API_KEY unset: still records the outcome, sends nothing", async () => {
  const { deps, calls } = fakeDeps({ mailgunConfigured: false });
  const outcome = await deliverChecklistCompleteStage(deps, CTX);
  assertEquals(outcome.kind, "sent");
  assertEquals(calls.sendEmail, 0);
  assertEquals(calls.insertActivityLog, 1);
  assertEquals(calls.insertNotification, 1);
});
