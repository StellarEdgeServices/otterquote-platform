// get-business-lines-dashboard/movement.test.ts
//
// gh-1570 — pure-unit tests for movement.ts.
//
// movement.ts is a real module with real exports (same shape as ga4.ts), so
// it is imported directly here — no source-extraction/data: URL indirection
// needed (contrast marketing-series.test.ts, which extracts from index.ts
// because index.ts itself has no exports).
//
// Covers: computeMovement/bucketFor (moved here unchanged from index.ts —
// asserted against the same day-boundary values index.ts always implied) and
// the new homeownerBucket override that stops the admin CRM "stuck-first"
// table from painting a zero-real-activity homeowner claim green just
// because an unrelated system write bumped updated_at.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  claimHasMilestoneProgress,
  type ClaimMilestones,
  computeMovement,
  bucketFor,
  homeownerBucket,
  isRealActivityRow,
} from "./movement.ts";

// A ClaimMilestones fixture with every signal false/null — callers override
// only the field(s) their case is about, so a new milestone column added to
// the interface later shows up here as "false by default", not a compile
// error scattered across every test.
function noProgress(overrides: Partial<ClaimMilestones> = {}): ClaimMilestones {
  return {
    status: "documents_needed",
    hasMeasurements: false,
    readyForBids: false,
    bidsReceived: 0,
    bidsSubmittedAt: null,
    contractSignedAt: null,
    colorSelectedAt: null,
    deductibleCollectedAt: null,
    selectedContractorId: null,
    platformFeeCharged: false,
    completionDate: null,
    ...overrides,
  };
}

Deno.test("bucketFor: green <=7, yellow <=13, red beyond", () => {
  assertEquals(bucketFor(0), "green");
  assertEquals(bucketFor(7), "green");
  assertEquals(bucketFor(8), "yellow");
  assertEquals(bucketFor(13), "yellow");
  assertEquals(bucketFor(14), "red");
  assertEquals(bucketFor(41), "red");
});

Deno.test("computeMovement: picks the max timestamp across inputs, null inputs ignored", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0); // 2026-09-15T00:00:00Z
  const result = computeMovement(now, [
    { label: "a", iso: null },
    { label: "b", iso: "2026-09-10T00:00:00Z" },
    { label: "c", iso: "2026-09-13T00:00:00Z" },
  ]);
  assertEquals(result.days, 2);
  assertEquals(result.latest_label, "c");
  assertEquals(result.latest_iso, "2026-09-13T00:00:00Z");
  assertEquals(result.bucket, "green");
});

Deno.test("computeMovement: all-null inputs -> unknown, no latest", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const result = computeMovement(now, [{ label: "a", iso: null }, { label: "b", iso: null }]);
  assertEquals(result.days, null);
  assertEquals(result.latest_label, null);
  assertEquals(result.latest_iso, null);
  assertEquals(result.bucket, "unknown");
});

// ── gh-1570 homeownerBucket override ────────────────────────────────────
// CEO RUN 48 fix-round (comment 5703958709): homeownerBucket's signature
// changed from (movement, firstActivityIso, hasClaim) to
// (movement, hasClaim, hasRealActivity) — hasRealActivity is now computed
// upstream (index.ts) from firstActivityIso OR claimIdsWithRealActivity OR
// claimHasMilestoneProgress, so these four cases pass it in pre-computed to
// keep testing homeownerBucket itself as a pure 2-input decision.

Deno.test("homeownerBucket (a): claim exists, zero real evidence at all, updated_at recently bumped -> red despite raw bucket", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0); // 2026-09-15T00:00:00Z
  // Claim created 60 days ago; updated_at bumped 2 days ago by an unrelated
  // system write; no real activity_log row ever, no milestone progress.
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-09-13T00:00:00Z" }, // 2 days ago
  ]);
  assertEquals(movement.bucket, "green"); // raw verdict, before the override
  const bucket = homeownerBucket(movement, /* hasClaim */ true, /* hasRealActivity */ false);
  assertEquals(bucket, "red");
});

Deno.test("homeownerBucket (b) NEGATIVE CONTROL: same claim, but real evidence exists -> ordinary bucketFor(2) = green, override does not fire", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-09-13T00:00:00Z" },
  ]);
  const bucket = homeownerBucket(movement, /* hasClaim */ true, /* hasRealActivity */ true);
  assertEquals(bucket, "green");
  assertEquals(bucket, movement.bucket);
});

Deno.test("homeownerBucket (c): no claim, no real activity -> unchanged bucketFor result (override only applies with a claim)", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  // No claim -> only a profile updated_at input, bumped 2 days ago.
  const movement = computeMovement(now, [
    { label: "profile updated_at", iso: "2026-09-13T00:00:00Z" },
  ]);
  assertEquals(movement.bucket, "green");
  const bucket = homeownerBucket(movement, /* hasClaim */ false, /* hasRealActivity */ false);
  assertEquals(bucket, "green");
  assertEquals(bucket, movement.bucket);
});

Deno.test("homeownerBucket (d): zero real activity, raw bucket already red -> red (idempotent)", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-07-01T00:00:00Z" }, // 76 days ago
  ]);
  assertEquals(movement.bucket, "red");
  const bucket = homeownerBucket(movement, /* hasClaim */ true, /* hasRealActivity */ false);
  assertEquals(bucket, "red");
});

// ── CEO RUN 48 fix-round — claimHasMilestoneProgress (gh-1570 blocking 1) ──
// REVIEW 5703958709 finding 1: the round-1 override forced red on ANY claim
// with no homeowner-keyed activity_log row, including claims that had moved
// far past documents_needed (bids, contract_signed, colour, measurements) —
// because those milestones never write one. These cases are the fix.

Deno.test("claimHasMilestoneProgress: documents_needed, nothing at all -> false (this is the only shape still forced red)", () => {
  assertEquals(claimHasMilestoneProgress(noProgress()), false);
});

Deno.test("claimHasMilestoneProgress: draft (earlier than documents_needed), nothing -> false", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ status: "draft" })), false);
});

Deno.test("claimHasMilestoneProgress: no claim at all -> false", () => {
  assertEquals(claimHasMilestoneProgress(null), false);
});

Deno.test("claimHasMilestoneProgress: status advanced past documents_needed (e.g. bidding) -> true even with zero other signals", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ status: "bidding" })), true);
});

Deno.test("claimHasMilestoneProgress: status contract_signed -> true", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ status: "contract_signed" })), true);
});

Deno.test("claimHasMilestoneProgress: bids exist (contractor-keyed, quotes count > 0) even though status is still documents_needed -> true", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ bidsReceived: 1 })), true);
});

Deno.test("claimHasMilestoneProgress: contract_signed_at set -> true (docusign's own activity_log row has no user_id, so this is the only signal)", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ contractSignedAt: "2026-09-03T00:00:00Z" })), true);
});

Deno.test("claimHasMilestoneProgress: colour selected -> true (colour selection logs no activity_log row anywhere)", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ colorSelectedAt: "2026-09-03T00:00:00Z" })), true);
});

Deno.test("claimHasMilestoneProgress: has_measurements true -> true (measurement UPLOAD logs nothing)", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ hasMeasurements: true })), true);
});

Deno.test("claimHasMilestoneProgress: deductible collected -> true", () => {
  assertEquals(claimHasMilestoneProgress(noProgress({ deductibleCollectedAt: "2026-09-03T00:00:00Z" })), true);
});

// ── CEO RUN 48 fix-round — isRealActivityRow (gh-1570 blocking 2) ─────────
// REVIEW 5703958709 finding 2: the PR's own motivating cases (4595b6f0,
// 16e18349) were NOT fixed because mark-loss-sheet-reviewed writes
// loss_sheet_reviewed under the homeowner's own user_id with no
// system_generated flag — an admin action the reader was counting as
// homeowner activity.

Deno.test("isRealActivityRow: loss_sheet_reviewed (admin-authored, mark-loss-sheet-reviewed) -> false", () => {
  assertEquals(
    isRealActivityRow({ event_type: "loss_sheet_reviewed", metadata: { claim_id: "c1", admin_email: "dustinstohler1@gmail.com" } }),
    false,
  );
});

Deno.test("isRealActivityRow: loss_sheet_review_cleared (admin-authored) -> false", () => {
  assertEquals(isRealActivityRow({ event_type: "loss_sheet_review_cleared", metadata: null }), false);
});

Deno.test("isRealActivityRow: system_generated nudge -> false (gh-1580's existing convention, unchanged)", () => {
  assertEquals(isRealActivityRow({ event_type: "next_steps_nudge_sent", metadata: { system_generated: true } }), false);
});

Deno.test("isRealActivityRow NEGATIVE CONTROL: a real homeowner-authored event (loss_sheet_parsed) -> true", () => {
  assertEquals(isRealActivityRow({ event_type: "loss_sheet_parsed", metadata: {} }), true);
});

Deno.test("isRealActivityRow NEGATIVE CONTROL: auto_bid_submitted (contractor-keyed, but a real event) -> true", () => {
  assertEquals(isRealActivityRow({ event_type: "auto_bid_submitted", metadata: { claim_id: "c1" } }), true);
});

// ── CEO RUN 48 fix-round — index.ts wiring (gh-1570 non-blocking 3) ───────
// CTO32 (5688879077) and CEO48 (5703958709) both found a mutant pointing
// index.ts's homeowner row back at bare `movement.bucket` survives
// `deno test` unchanged (99 passed either way) because nothing exercises
// index.ts's own composition of the pieces movement.ts exports — only the
// pieces themselves. This is a cheap source-level regression lock: it reads
// index.ts's own text and fails if the homeowner row's bucket assignment no
// longer calls the override, i.e. if someone reverts exactly the mutant
// both reviews tried.
Deno.test("index.ts wiring: the homeowner row's bucket assignment calls the override, not bare movement.bucket", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assert(
    src.includes('bucket: isComplete ? "complete" : zeroActivityBucket,'),
    "index.ts no longer assigns the homeowner row's movement.bucket from the " +
      "zero-activity override (zeroActivityBucket) — this is the exact " +
      "mutant CTO32/CEO48 both applied by hand and found undetected.",
  );
  assert(
    src.includes("const zeroActivityBucket = homeownerBucket(movement, !!claim, hasRealActivity);"),
    "index.ts no longer computes zeroActivityBucket via homeownerBucket(movement, !!claim, hasRealActivity) " +
      "— the wiring between movement.ts's pure functions and the homeowner row changed shape.",
  );
});
