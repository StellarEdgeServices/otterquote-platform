// get-business-lines-dashboard/homeowner-row.test.ts
//
// CEO RUN 48 FIX ROUND 2 (review 5705734203, finding 3) — genuine behavioral
// wiring tests for the homeowner CRM row, replacing round 1's wiring test
// (movement.test.ts's old "index.ts wiring" Deno.test), which review2
// correctly called out as "a string match on two lines; it does not
// exercise how the row is built."
//
// index.ts is a single-file EF with no exports (same shape marketing-
// series.test.ts already works around for this exact file), so this test
// uses the identical source-extraction technique: read index.ts as text,
// pull out the real `buildHomeownerRow` function body verbatim (the same
// brace-counting grabBlock() this directory's marketing-series.test.ts and
// ga4-report/index.test.ts already use), re-export it, and import the
// result via a data: URL alongside REAL imports of its movement.ts
// dependencies (claimHasMilestoneProgress, claimUpdatedAtIsAdminTainted,
// computeMovement, homeownerBucket). This exercises the actual production
// implementation, not a re-implementation of it — a revert of index.ts's
// wiring (round 1's logic, or removing the admin-row filter in movement.ts)
// makes these tests fail. See the mutant-proof transcript pasted in the
// PR #1976 FIX ROUND 2 evidence comment.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const movementModuleUrl = new URL("./movement.ts", import.meta.url).href;

// Same string/template-literal-aware brace counter as marketing-series.test.ts
// and ga4-report/index.test.ts, PLUS comment-awareness (// and /* */): none
// of the source-extracted functions in this repo's existing tests have a
// prose comment with an apostrophe inside their body, but buildHomeownerRow's
// documentation comments do ("homeowner's", "claim's", "doesn't", ...) —
// without tracking comment state, an apostrophe inside a `//` line comment
// is misread as opening a string literal, which desyncs the brace count for
// everything after it and (observed while writing this test) silently grabs
// the rest of the file instead of throwing. Comment-tracking is the fix;
// the underlying technique (execute the real extracted source, don't
// re-implement it) is unchanged.
function grabBlock(marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let state: "code" | "dq" | "sq" | "tpl" | "line-comment" | "block-comment" = "code";
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    const next = src[j + 1];
    if (state === "line-comment") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (c === "*" && next === "/") { state = "code"; j++; }
      continue;
    }
    if (state === "dq" || state === "sq" || state === "tpl") {
      if (c === "\\") { j++; continue; }
      if ((state === "dq" && c === '"') || (state === "sq" && c === "'") || (state === "tpl" && c === "`")) {
        state = "code";
      }
      continue;
    }
    // state === "code"
    if (c === "/" && next === "/") { state = "line-comment"; j++; continue; }
    if (c === "/" && next === "*") { state = "block-comment"; j++; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "'") { state = "sq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${marker}`);
}

const mod = [
  `import { claimHasMilestoneProgress, claimUpdatedAtIsAdminTainted, computeMovement, homeownerBucket, type ClaimMilestones } from "${movementModuleUrl}";`,
  grabBlock("interface HomeownerProfileLike").replace(
    "interface HomeownerProfileLike",
    "export interface HomeownerProfileLike",
  ),
  grabBlock("function buildHomeownerRow(").replace(
    "function buildHomeownerRow(",
    "export function buildHomeownerRow(",
  ),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
// deno-lint-ignore no-explicit-any
const { buildHomeownerRow } = await import(url) as any;

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

// A profile fixture — override only what a case is about.
function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    full_name: "Test Homeowner",
    email: "test@example.com",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    is_test: false,
    ...overrides,
  };
}

// A claim fixture with every signal null/false by default, same convention
// as movement.test.ts's noProgress().
function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    user_id: "u1",
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
    status: "documents_needed",
    hover_order_id: null,
    hover_status: null,
    has_measurements: false,
    ready_for_bids: false,
    bids_submitted_at: null,
    selected_contractor_id: null,
    contract_sent_at: null,
    contract_signed_at: null,
    platform_fee_charged: false,
    completion_date: null,
    color_selected_at: null,
    deductible_collected_at: null,
    loss_sheet_reviewed_at: null,
    is_test: false,
    ...overrides,
  };
}

const emptyMaps = () => ({
  quotesByClaimId: new Map<string, unknown[]>(),
  lastActivityByUser: new Map<string, string>(),
  firstActivityByUser: new Map<string, string>(),
  claimIdsWithRealActivity: new Set<string>(),
  claimLastRealActivityByClaimId: new Map<string, string>(),
});

function run(p: unknown, userClaims: unknown[], overrides: Partial<ReturnType<typeof emptyMaps>> = {}) {
  const m = { ...emptyMaps(), ...overrides };
  return buildHomeownerRow(
    p,
    NOW,
    userClaims,
    m.quotesByClaimId,
    m.lastActivityByUser,
    m.firstActivityByUser,
    m.claimIdsWithRealActivity,
    m.claimLastRealActivityByClaimId,
  );
}

// ── B1 (review 5705734203 finding 1) — admin-tainted claim.updated_at ────

Deno.test("buildHomeownerRow (B1): 4595b6f0 shape — draft claim, admin-reviewed, zero real evidence -> red, and claim.updated_at (admin-tainted) is NOT the movement input", () => {
  // updated_at bumped by the SAME admin write that set loss_sheet_reviewed_at
  // (0.237s apart, same shape as the live 4595b6f0 row cited in movement.ts),
  // 7 days before NOW — this is exactly the raw shape that would read
  // "7 days, green" if claim.updated_at were allowed to feed movement.
  const c = claim({
    updated_at: "2026-09-09T11:21:03.079Z",
    loss_sheet_reviewed_at: "2026-09-09T11:21:02.842Z",
  });
  const p = profile({ updated_at: "2026-08-01T00:00:00Z" }); // old, uninformative
  const row = run(p, [c]);
  assertEquals(row.movement.bucket, "red", "hasRealActivity is false (no milestones, admin row already excluded upstream) -> the zero-activity override must force red");
  assertEquals(row.movement.zero_activity, true);
  assertNotEquals(row.movement.latest_label, "claim updated_at", "claim.updated_at was admin-tainted and must be excluded from the movement inputs entirely");
});

Deno.test("buildHomeownerRow (B1) NEGATIVE CONTROL: same admin-review timing, but claim HAS real milestone progress -> not forced red, and claim.updated_at is still excluded from recency (73208937-style genuine activity must date recency from the real milestone, not the admin bump)", () => {
  const c = claim({
    updated_at: "2026-09-09T11:21:03.079Z",
    loss_sheet_reviewed_at: "2026-09-09T11:21:02.842Z",
    platform_fee_charged: true, // real progress signal, independent of any activity_log row
    color_selected_at: "2026-08-20T00:00:00Z", // real, older, non-admin timestamp
  });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.zero_activity, false, "claimHasMilestoneProgress is true -> this claim is not stuck, override must not fire");
  assertNotEquals(row.movement.latest_label, "claim updated_at", "claim.updated_at is still admin-tainted here even though the claim has real progress elsewhere");
  assertEquals(row.movement.latest_label, "claim color_selected_at", "recency must come from the real milestone timestamp, not the admin-bumped updated_at");
});

Deno.test("buildHomeownerRow NEGATIVE CONTROL: claim.updated_at with NO loss_sheet_reviewed_at at all (73208937/f57c49a0 shape) -> updated_at is a real signal and IS used", () => {
  const c = claim({
    updated_at: "2026-09-14T00:00:00Z", // 2 days ago
    loss_sheet_reviewed_at: null,
    platform_fee_charged: true, // e.g. 73208937's real Stripe charge
  });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.latest_label, "claim updated_at");
  assertEquals(row.movement.bucket, "green");
  assertEquals(row.movement.zero_activity, false);
});

// ── item 4 (system-notification exclusion) at the full-row level ─────────
// This is the actual mechanism behind the 4595b6f0/16e18349 "still green"
// symptom review2 reported at head 63e71dc9: round 1 only excluded
// ADMIN_ORIGIN_EVENT_TYPES from claimIdsWithRealActivity, not
// SYSTEM_NOTIFICATION_EVENT_TYPES (notification_failed,
// measurement_order_fulfilled, bid_confirmation_email_sent, ...) — so a
// claim whose ONLY "activity" was a failed-notification row referencing its
// claim_id in metadata still read as hasRealActivity=true and fell through
// to the (admin-tainted) raw bucket instead of being forced red.
Deno.test("buildHomeownerRow: claim referenced ONLY by a system-notification row (simulating the pre-item-4-fix reducer output) -> red once that reference is correctly excluded upstream", () => {
  const c = claim({
    updated_at: "2026-09-09T00:00:00Z", // 7 days ago — would read green if not overridden
  });
  const p = profile();
  // Correct (post-fix) reducer output: the notification_failed row's claim_id
  // was excluded by isRealActivityRow, so claimIdsWithRealActivity does NOT
  // contain c1.
  const fixed = run(p, [c], { claimIdsWithRealActivity: new Set() });
  assertEquals(fixed.movement.bucket, "red");
  assertEquals(fixed.movement.zero_activity, true);

  // Mutant: the round-1 reducer (before item 4's SYSTEM_NOTIFICATION_EVENT_TYPES
  // exclusion existed) would have put c1 into this set, because
  // notification_failed carries metadata.claim_id and round 1's
  // isRealActivityRow did not yet filter it.
  const mutant = run(p, [c], { claimIdsWithRealActivity: new Set(["c1"]) });
  assertEquals(mutant.movement.bucket, "green", "documents this is exactly the shape that produced the reported false-green — see isRealActivityRow's SYSTEM_NOTIFICATION_EVENT_TYPES test in movement.test.ts for the fix at its source");
});

// ── item 5 (status allowlist) at the full-row level ───────────────────────

Deno.test("buildHomeownerRow: unrecognized/garbage status, zero other signals -> still red (allowlist, not denylist)", () => {
  const c = claim({ status: "some_future_or_cancelled_status_not_in_the_check_constraint" });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.zero_activity, true, "an unrecognized status must NOT be treated as progress");
  assertEquals(row.movement.bucket, "red");
});

Deno.test("buildHomeownerRow NEGATIVE CONTROL: status explicitly in the progress allowlist (bidding), zero other signals -> not forced red", () => {
  const c = claim({ status: "bidding" });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.zero_activity, false);
});

// ── B2 (review 5705734203 finding 2, DECIDED) — is_test reverted ─────────

Deno.test("buildHomeownerRow (B2): is_test always comes from the PROFILE, never the claim, even when a claim exists with a different flag", () => {
  const c = claim({ is_test: true });
  const p = profile({ is_test: false });
  const row = run(p, [c]);
  assertEquals(row.is_test, false, "round 1's claim-first precedence hid 73208937/474af0fc — B2 reverted this to main's behavior exactly");
});

Deno.test("buildHomeownerRow (B2): no claim -> is_test still comes from the profile", () => {
  const p = profile({ is_test: true });
  const row = run(p, []);
  assertEquals(row.is_test, true);
});

// ── isComplete still wins over the override ───────────────────────────────

Deno.test("buildHomeownerRow: a COMPLETE claim with zero real activity evidence is still bucketed 'complete', not forced red", () => {
  const c = claim({ completion_date: "2026-09-01T00:00:00Z" });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.bucket, "complete");
});

// ── claim-referenced real activity feeds recency, not just the red/green
// decision (new in FIX ROUND 2) ───────────────────────────────────────────

Deno.test("buildHomeownerRow: a claim-referenced real activity row (e.g. a contractor bid) dates movement recency, not just hasRealActivity", () => {
  const c = claim({ updated_at: "2026-07-01T00:00:00Z" }); // stale, would be red on its own
  const p = profile({ updated_at: "2026-07-01T00:00:00Z" });
  const row = run(p, [c], {
    claimIdsWithRealActivity: new Set(["c1"]),
    claimLastRealActivityByClaimId: new Map([["c1", "2026-09-15T00:00:00Z"]]), // 1 day ago
  });
  assertEquals(row.movement.zero_activity, false);
  assertEquals(row.movement.latest_label, "claim-referenced activity_log event");
  assertEquals(row.movement.bucket, "green");
});
