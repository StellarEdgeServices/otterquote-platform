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

const mod = [
  `import { claimHasMilestoneProgress, computeMovement, homeownerBucket, type ClaimMilestones } from "${movementModuleUrl}";`,
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

// ── B1 (review 5706511176 finding B1, DECIDED, FIX ROUND 3) ──────────────
// claim.updated_at / profile.updated_at are NEVER a movement input, full
// stop — not "unless admin-tainted" (review 2's now-removed heuristic), just
// never. These tests prove it for BOTH kinds of writer review3 named: an
// admin write (mark-loss-sheet-reviewed, the 4595b6f0 shape) and a plain
// cron/trigger write (process-bid-expirations, the cbf2c780 shape) get
// identical treatment — because there is no special-casing left at all.

Deno.test("buildHomeownerRow (B1) FIX ROUND 3: 4595b6f0 shape — draft claim, has_measurements=true (real progress) but NO allow-listed timestamp and NO qualifying activity_log row -> movement is 'unknown' pre-override, and homeownerBucket forces red", () => {
  const c = claim({
    has_measurements: true, // real progress; keeps claimHasMilestoneProgress true
    updated_at: "2026-09-09T11:21:03.079Z", // recent-ish; MUST be ignored entirely
  });
  const p = profile({ updated_at: "2026-08-01T00:00:00Z" }); // also MUST be ignored entirely
  const row = run(p, [c]);
  assertEquals(row.movement.latest_iso, null, "no allow-listed claim timestamp and no real activity_log row exist in this fixture -> nothing should have fed computeMovement");
  assertEquals(row.movement.zero_activity, false, "claimHasMilestoneProgress is true (has_measurements) -> this is NOT the zero-activity case");
  assertEquals(row.movement.bucket, "red", "an 'unknown' recency on a claim is forced red too (homeownerBucket) -- exactly the live 4595b6f0 shape");
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
