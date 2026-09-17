// get-business-lines-dashboard/homeowner-row.test.ts
//
// CEO RUN 48 FIX ROUND 2 (review 5705734203, finding 3) — genuine behavioral
// wiring tests for the homeowner CRM row, replacing round 1's wiring test
// (movement.test.ts's old "index.ts wiring" Deno.test), which review2
// correctly called out as "a string match on two lines; it does not
// exercise how the row is built." FIX ROUND 3 (review 5706511176) rewrote
// the B1 section: claim.updated_at/profile.updated_at are no longer read for
// movement AT ALL (movement.ts's homeownerBucket header comment has the full
// rationale), so the old "admin-tainted timestamp" tests are replaced with
// tests that prove updated_at is never an input, period — including the
// live cbf2c780 shape (a cron bump, not an admin one).
//
// index.ts is a single-file EF with no exports (same shape marketing-
// series.test.ts already works around for this exact file), so this test
// uses the identical source-extraction technique: read index.ts as text,
// pull out the real `buildHomeownerRow` function body verbatim (the same
// brace-counting grabBlock() this directory's marketing-series.test.ts and
// ga4-report/index.test.ts already use), re-export it, and import the
// result via a data: URL alongside REAL imports of its movement.ts
// dependencies (claimHasMilestoneProgress, computeMovement, homeownerBucket).
// This exercises the actual production implementation, not a
// re-implementation of it — a revert of index.ts's wiring (any prior
// round's logic, or removing the admin-row filter in movement.ts) makes
// these tests fail. See the mutant-proof transcript pasted in the PR #1976
// FIX ROUND 3 evidence comment.
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

// FIX ROUND 4 (review 5707823658, finding #4, DEAD MUTANT): reduceActivity
// (the loop that used to be inline in the main handler, now its own
// top-level function — see index.ts's header comment on it) and
// resolveMissingCreatedAt (finding #1's auth.users.created_at fallback) are
// extracted the same way buildHomeownerRow already is, so both are exercised
// by their real production source, not a re-implementation.
const mod = [
  `import { claimHasMilestoneProgress, computeMovement, homeownerBucket, isRealActivityRow, type ClaimMilestones } from "${movementModuleUrl}";`,
  grabBlock("interface ActivityRow").replace(
    "interface ActivityRow",
    "export interface ActivityRow",
  ),
  grabBlock("interface HomeownerProfileLike").replace(
    "interface HomeownerProfileLike",
    "export interface HomeownerProfileLike",
  ),
  grabBlock("function buildHomeownerRow(").replace(
    "function buildHomeownerRow(",
    "export function buildHomeownerRow(",
  ),
  grabBlock("interface ActivityReductions").replace(
    "interface ActivityReductions",
    "export interface ActivityReductions",
  ),
  grabBlock("function reduceActivity(").replace(
    "function reduceActivity(",
    "export function reduceActivity(",
  ),
  grabBlock("interface ProfileCreatedAtLike").replace(
    "interface ProfileCreatedAtLike",
    "export interface ProfileCreatedAtLike",
  ),
  grabBlock("async function resolveMissingCreatedAt(").replace(
    "async function resolveMissingCreatedAt(",
    "export async function resolveMissingCreatedAt(",
  ),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
// deno-lint-ignore no-explicit-any
const { buildHomeownerRow, reduceActivity, resolveMissingCreatedAt } = await import(url) as any;

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
// as movement.test.ts's noProgress(). updated_at defaults to something
// RECENT and deliberately noisy (a cron-shaped bump) — every test that does
// not care about updated_at should still pass, which is itself part of the
// FIX ROUND 3 proof: updated_at is inert no matter what it says.
function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    user_id: "u1",
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-09-16T11:59:00Z", // ~1 minute before NOW — would read "0 days, green" if it leaked in
    status: "documents_needed",
    hover_order_id: null,
    hover_status: null,
    has_measurements: false,
    ready_for_bids: false,
    bids_submitted_at: null,
    selected_contractor_id: null,
    contract_sent_at: null,
    contract_signed_at: null,
    contract_declined_at: null,
    contract_voided_at: null,
    color_confirmed_at: null,
    contractor_switched_at: null,
    project_confirmation_signed_at: null,
    platform_fee_charged: false,
    completion_date: null,
    color_selected_at: null,
    deductible_collected_at: null,
    is_test: false,
    // FIX ROUND 4 (review 5707823658, finding #3): the four "bids released
    // to contractors" milestone columns, and the four-column real-life
    // schema (roofing_bid_released_at etc.) — default null, every test that
    // does not care overrides nothing.
    gutters_bid_released_at: null,
    roofing_bid_released_at: null,
    siding_bid_released_at: null,
    windows_bid_released_at: null,
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

function run(
  p: unknown,
  userClaims: unknown[],
  overrides: Partial<ReturnType<typeof emptyMaps>> = {},
  // FIX ROUND 4: an optional "now" override, for the one test (the
  // f57c49a0 submit-for-bids simulation) that needs to assert `days === 0`
  // at the exact instant a milestone timestamp is stamped — every other
  // test keeps using the fixed module-level NOW.
  nowOverride?: string,
) {
  const m = { ...emptyMaps(), ...overrides };
  return buildHomeownerRow(
    p,
    nowOverride ? Date.parse(nowOverride) : NOW,
    userClaims,
    m.quotesByClaimId,
    m.lastActivityByUser,
    m.firstActivityByUser,
    m.claimIdsWithRealActivity,
    m.claimLastRealActivityByClaimId,
  );
}

// ── B1 (review 5706511176 finding B1, DECIDED, FIX ROUND 3) ──────────────
// claim.updated_at / profile.updated_at are NEVER a movement input, full
// stop — not "unless admin-tainted" (review 2's now-removed heuristic), just
// never. These tests prove it for BOTH kinds of writer review3 named: an
// admin write (mark-loss-sheet-reviewed, the 4595b6f0 shape) and a plain
// cron/trigger write (process-bid-expirations, the cbf2c780 shape) get
// identical treatment — because there is no special-casing left at all.

Deno.test("buildHomeownerRow (B1) FIX ROUND 4: 4595b6f0 shape — draft claim, has_measurements=true (real progress) but NO allow-listed timestamp and NO qualifying activity_log row -> claim.created_at is the recency floor, naturally red off real age (not 'unknown')", () => {
  const c = claim({
    has_measurements: true, // real progress; keeps claimHasMilestoneProgress true
    created_at: "2026-08-05T00:00:00Z", // ~42 days before NOW -- the live shape
    updated_at: "2026-09-09T11:21:03.079Z", // recent-ish; MUST still be ignored entirely
  });
  const p = profile({ updated_at: "2026-08-01T00:00:00Z" }); // also MUST be ignored entirely
  const row = run(p, [c]);
  assertEquals(row.movement.latest_label, "claim created_at", "FIX ROUND 4: with no other allow-listed timestamp and no real activity_log row, the claim's own creation date is the only (and correct) recency input");
  assertEquals(row.movement.latest_iso, "2026-08-05T00:00:00Z");
  assertEquals(row.movement.zero_activity, false, "claimHasMilestoneProgress is true (has_measurements) -> this is NOT the zero-activity case");
  assertEquals(row.movement.bucket, "red", "old enough (42 days) to be naturally red off its own creation date -- no longer via the 'unknown' force-red path");
});

Deno.test("buildHomeownerRow (B1) FIX ROUND 4 DEFENSE-IN-DEPTH: a claim whose OWN created_at is somehow null (schema-nullable, zero live rows), no other evidence -> movement is genuinely 'unknown' pre-override, and homeownerBucket still forces red", () => {
  const c = claim({
    has_measurements: true,
    created_at: null as unknown as string, // the one shape FIX ROUND 4's floor cannot cover
  });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.latest_iso, null, "no admissible input at all in this edge case");
  assertEquals(row.movement.zero_activity, false, "claimHasMilestoneProgress is true -> not the zero-activity case");
  assertEquals(row.movement.bucket, "red", "'unknown' recency on a claim is still forced red (homeownerBucket) as defense in depth");
});

Deno.test("buildHomeownerRow (B1) FIX ROUND 3, cbf2c780 SHAPE: claim.updated_at bumped by a cron 1 minute ago, but the claim's real milestone history is weeks old -> recency comes from the real milestones, NEVER shows '0 days'", () => {
  const c = claim({
    status: "bidding",
    bids_submitted_at: "2026-08-11T14:11:11.866Z", // ~36 days before NOW
    // contract_sent_at is the MORE RECENT real signal, ~13 days before NOW —
    // this is the one that should win, not the 1-minute-old updated_at.
    contract_sent_at: "2026-09-03T18:35:38.932Z",
    updated_at: "2026-09-16T11:59:59Z", // cron-bumped ~1 second before NOW
  });
  const p = profile();
  const row = run(p, [c]);
  assertNotEquals(row.movement.days, 0, "must not read '0 days' off the cron-bumped claim.updated_at (the live cbf2c780 symptom)");
  assertEquals(row.movement.latest_label, "claim contract_sent_at", "the most recent REAL milestone timestamp must win, not the cron's touch");
  assert((row.movement.days ?? 0) >= 12, `expected >= 12 days since the real 2026-09-03 contract_sent_at, got ${row.movement.days}`);
});

Deno.test("buildHomeownerRow (B1) FIX ROUND 3 NEGATIVE CONTROL: claim has a real, recent milestone timestamp -> normal bucket, not forced, and it is genuinely used", () => {
  const c = claim({
    platform_fee_charged: true, // real progress signal, independent of any activity_log row
    color_selected_at: "2026-09-15T00:00:00Z", // real, 2 days before NOW
    updated_at: "2026-07-01T00:00:00Z", // stale and IRRELEVANT — must not suppress the real recent signal
  });
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.zero_activity, false, "claimHasMilestoneProgress is true -> this claim is not stuck, override must not fire");
  assertEquals(row.movement.latest_label, "claim color_selected_at", "recency must come from the real milestone timestamp");
  assertEquals(row.movement.bucket, "green");
});

Deno.test("buildHomeownerRow (B1) FIX ROUND 3: bids.created_at (a contractor's quote) is an explicit milestone timestamp", () => {
  const c = claim({ status: "bidding" });
  const p = profile();
  const quotesByClaimId = new Map<string, unknown[]>([
    ["c1", [{ id: "q1", created_at: "2026-09-14T00:00:00Z" }, { id: "q2", created_at: "2026-09-10T00:00:00Z" }]],
  ]);
  const row = run(p, [c], { quotesByClaimId });
  assertEquals(row.movement.latest_label, "claim quotes.created_at (latest bid received)");
  assertEquals(row.movement.latest_iso, "2026-09-14T00:00:00Z", "the LATEST of multiple bids must win");
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
  const c = claim(); // no milestone progress, no allow-listed timestamp
  const p = profile();
  // Correct (post-fix) reducer output: the notification_failed row's claim_id
  // was excluded by isRealActivityRow, so neither claimIdsWithRealActivity
  // nor claimLastRealActivityByClaimId contains c1.
  const fixed = run(p, [c], { claimIdsWithRealActivity: new Set(), claimLastRealActivityByClaimId: new Map() });
  assertEquals(fixed.movement.bucket, "red");
  assertEquals(fixed.movement.zero_activity, true);

  // Mutant: the round-1 reducer (before item 4's SYSTEM_NOTIFICATION_EVENT_TYPES
  // exclusion existed) would have put c1 into BOTH maps together (they are
  // populated from the same loop iteration in index.ts), because
  // notification_failed carries metadata.claim_id and round 1's
  // isRealActivityRow did not yet filter it — including its own (recent)
  // created_at as a false recency signal.
  const mutant = run(p, [c], {
    claimIdsWithRealActivity: new Set(["c1"]),
    claimLastRealActivityByClaimId: new Map([["c1", "2026-09-15T00:00:00Z"]]), // 2 days before NOW
  });
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

// ── FIX ROUND 4 (review 5707823658, finding #1, DECIDED) ──────────────────
// A homeowner with no claim yet must bucket by SIGNUP AGE (profile
// created_at), not be left at raw 'unknown' (FIX ROUND 3's gap) and not read
// profile.updated_at (FIX ROUND 3's own rule, which this must not regress).

Deno.test("buildHomeownerRow, FIX ROUND 4 finding #1: no claim -> movement comes from profile created_at (signup age), a stale/absent updated_at is irrelevant", () => {
  const p = profile({
    created_at: "2026-09-14T12:00:00Z", // exactly 2 days before NOW -> green
    updated_at: "2026-01-01T00:00:00Z", // wildly stale; MUST be ignored (FIX ROUND 3's rule, still in force)
  });
  const row = run(p, []);
  assertEquals(row.movement.latest_label, "profile created_at (signup, no claim yet)");
  assertEquals(row.movement.latest_iso, "2026-09-14T12:00:00Z");
  assertEquals(row.movement.days, 2);
  assertEquals(row.movement.bucket, "green");
  assertEquals(row.movement.zero_activity, false, "zero_activity is claim-scoped -- a no-claim row is never the zero-activity case");
});

Deno.test("buildHomeownerRow, FIX ROUND 4 finding #1: no claim, old signup -> naturally red off signup age (main's colours restored, not forced via any override)", () => {
  const p = profile({ created_at: "2026-05-14T22:45:37Z" }); // ~125 days before NOW
  const row = run(p, []);
  assertEquals(row.movement.bucket, "red");
  assertEquals(row.movement.zero_activity, false);
});

Deno.test("buildHomeownerRow NEGATIVE CONTROL, FIX ROUND 4 finding #1: no claim, but a real activity_log row exists -> that wins over signup age", () => {
  const p = profile({ created_at: "2026-05-14T22:45:37Z" }); // ~125 days ago -- would be red alone
  const row = run(p, [], { lastActivityByUser: new Map([["u1", "2026-09-15T00:00:00Z"]]) }); // 1 day ago
  assertEquals(row.movement.latest_label, "activity_log last event");
  assertEquals(row.movement.bucket, "green");
});

// ── FIX ROUND 4 (review 5707823658, finding #3, DECIDED) ──────────────────
// *_bid_released_at columns as an explicit milestone timestamp, and the
// f57c49a0 "submit-for-bids" simulation the review specifically asked for.

Deno.test("buildHomeownerRow, FIX ROUND 4 finding #3: a *_bid_released_at column is an explicit milestone timestamp and wins recency when it is the latest", () => {
  const c = claim({ status: "bidding", roofing_bid_released_at: "2026-09-16T00:00:00Z" }); // 1 day ago
  const p = profile();
  const row = run(p, [c]);
  assertEquals(row.movement.latest_label, "claim *_bid_released_at (any trade)");
  assertEquals(row.movement.latest_iso, "2026-09-16T00:00:00Z");
  assertEquals(row.movement.bucket, "green");
});

Deno.test("buildHomeownerRow, FIX ROUND 4 finding #3: f57c49a0 SUBMIT-FOR-BIDS SIMULATION — documents_needed/zero-evidence claim (live red shape) that just had submitForBids run on it -> green/0, like main, not red", () => {
  // Live f57c49a0 shape BEFORE simulating the action: documents_needed,
  // no measurements, no bid columns -> forced red, zero_activity.
  const before = claim({ status: "documents_needed", created_at: "2026-09-16T01:04:43.981Z" });
  const p = profile();
  const rowBefore = run(p, [before]);
  assertEquals(rowBefore.movement.zero_activity, true, "sanity check: this is the live pre-submit shape");
  assertEquals(rowBefore.movement.bucket, "red");

  // react-app's submitForBids (dashboard/actions.ts) on the homeowner's own
  // click: status -> 'active', ready_for_bids -> true, and stamps every
  // releasable trade's *_bid_released_at to NOW.
  const after = claim({
    status: "active",
    ready_for_bids: true,
    created_at: "2026-09-16T01:04:43.981Z",
    roofing_bid_released_at: "2026-09-17T03:51:23Z", // "now" at simulation time
    gutters_bid_released_at: "2026-09-17T03:51:23Z",
    windows_bid_released_at: "2026-09-17T03:51:23Z",
  });
  const rowAfter = run(p, [after], {}, "2026-09-17T03:51:23Z");
  assertEquals(rowAfter.movement.zero_activity, false, "submitForBids is real, homeowner-initiated progress -> no longer the zero-activity case");
  assertEquals(rowAfter.movement.latest_label, "claim *_bid_released_at (any trade)");
  assertEquals(rowAfter.movement.days, 0);
  assertEquals(rowAfter.movement.bucket, "green", "must show green/0 immediately after a homeowner submits for bids, exactly like main");
});

// ── FIX ROUND 4 (review 5707823658, finding #4, DEAD MUTANT) ──────────────
// reduceActivity is index.ts's ACTUAL loop (extracted verbatim, see its
// header comment) — this exercises the real production filter end-to-end,
// not isRealActivityRow in isolation (movement.test.ts already covers that).

Deno.test("reduceActivity, FIX ROUND 4 finding #4: an admin loss_sheet_reviewed row and a system-generated nudge are excluded from ALL FOUR output structures; only the real row survives", () => {
  const rows = [
    // Admin-authored, homeowner's own user_id (the ORIGINAL gh-1570 bug shape).
    { user_id: "u1", event_type: "loss_sheet_reviewed", metadata: { claim_id: "c1", admin_email: "x@y.com" }, created_at: "2026-09-10T00:00:00Z" },
    // System-generated absence nudge, homeowner's own user_id.
    { user_id: "u1", event_type: "next_steps_nudge_sent", metadata: { claim_id: "c1", system_generated: true }, created_at: "2026-09-11T00:00:00Z" },
    // One real, homeowner-authored row referencing the same claim.
    { user_id: "u1", event_type: "loss_sheet_parsed", metadata: { claim_id: "c1" }, created_at: "2026-09-12T00:00:00Z" },
  ];
  const r = reduceActivity(rows);
  assertEquals(r.lastActivityByUser.get("u1"), "2026-09-12T00:00:00Z", "the admin row (09-10) and the system nudge (09-11) must not win the max() over the real row (09-12)");
  assertEquals(r.firstActivityByUser.get("u1"), "2026-09-12T00:00:00Z", "and must not win the min() either -- the real row is the ONLY one counted at all");
  assertEquals(r.claimIdsWithRealActivity.has("c1"), true, "the real row alone is enough for the claim to be marked");
  assertEquals(r.claimLastRealActivityByClaimId.get("c1"), "2026-09-12T00:00:00Z");
});

Deno.test("reduceActivity MUTANT (must fail): swapping the filter for main's pre-gh-1570 loop (which counted every row unconditionally) lets the admin/system rows win", () => {
  // This is the mutant literally, not a simulation: main's original reducer
  // had no isRealActivityRow call at all -- every row counted. Reproduced
  // inline so this test file documents (and can re-run) the exact failing
  // transcript pasted in the evidence comment.
  function reduceActivityMUTANT(activityLog: typeof rows) {
    const lastActivityByUser = new Map<string, string>();
    for (const row of activityLog) {
      // MUTANT: the `if (!isRealActivityRow(row)) continue;` guard is GONE.
      const prevLast = lastActivityByUser.get(row.user_id!);
      if (!prevLast || new Date(row.created_at).getTime() > new Date(prevLast).getTime()) {
        lastActivityByUser.set(row.user_id!, row.created_at);
      }
    }
    return { lastActivityByUser };
  }
  const rows = [
    { user_id: "u1", event_type: "loss_sheet_parsed", metadata: { claim_id: "c1" }, created_at: "2026-09-12T00:00:00Z" },
    { user_id: "u1", event_type: "next_steps_nudge_sent", metadata: { claim_id: "c1", system_generated: true }, created_at: "2026-09-13T00:00:00Z" }, // LATER than the real row
  ];
  const mutantResult = reduceActivityMUTANT(rows);
  const realResult = reduceActivity(rows);
  // The mutant WRONGLY lets the system nudge (09-13) win over the real row
  // (09-12) -- exactly the false-freshness bug this whole file exists to
  // prevent. The real reduceActivity correctly stops at the real row.
  assertEquals(mutantResult.lastActivityByUser.get("u1"), "2026-09-13T00:00:00Z", "documenting the mutant's WRONG answer");
  assertEquals(realResult.lastActivityByUser.get("u1"), "2026-09-12T00:00:00Z", "the real filter correctly excludes the nudge");
  assertNotEquals(mutantResult.lastActivityByUser.get("u1"), realResult.lastActivityByUser.get("u1"), "the mutant and the real implementation MUST disagree -- if they ever agree, this test stopped detecting the regression");
});

// ── FIX ROUND 4 (review 5707823658, finding #1) — resolveMissingCreatedAt ──

Deno.test("resolveMissingCreatedAt: only profiles with a missing created_at are looked up at all", async () => {
  const looked_up: string[] = [];
  const profiles = [
    { id: "u1", created_at: "2026-08-01T00:00:00Z" }, // has one -- must NOT be looked up
    { id: "u2", created_at: null }, // missing -- must be looked up
  ];
  const result = await resolveMissingCreatedAt(profiles, async (userId: string) => {
    looked_up.push(userId);
    return "2026-06-01T00:00:00Z";
  });
  assertEquals(looked_up, ["u2"], "a profile that already has created_at must never trigger an auth.admin.getUserById lookup");
  assertEquals(result.get("u2"), "2026-06-01T00:00:00Z");
  assertEquals(result.has("u1"), false);
});

Deno.test("resolveMissingCreatedAt NEGATIVE CONTROL: the auth lookup itself returning null does not add an entry", async () => {
  const profiles = [{ id: "u3", created_at: null }];
  const result = await resolveMissingCreatedAt(profiles, async () => null);
  assertEquals(result.has("u3"), false, "an exhausted fallback is a real null, not a fabricated entry");
});
