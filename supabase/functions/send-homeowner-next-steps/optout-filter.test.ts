// gh-1786 / D-320 — sender-side suppression tests.
// Run: deno test supabase/functions/send-homeowner-next-steps/optout-filter.test.ts
//
// #1786's closes-on: "a seeded suppressed recipient observed being SKIPPED while
// an unsuppressed one on the same run is sent — so a change that suppresses
// everybody, or nobody, cannot pass as a success." Both halves are asserted in
// the same test against the same input set.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  canSendWithOptOut,
  collectOptedOutClaimIds,
  fetchOptedOutClaimIds,
  isOptedOut,
  type ActivityRowLike,
  type OptOutFilterBuilder,
  type OptOutQueryClient,
} from "./optout-filter.ts";
import { OPTOUT_EVENT_TYPE } from "./optout-token.ts";

const SUPPRESSED = "aaaaaaaa-0000-0000-0000-000000000001";
const ALLOWED = "bbbbbbbb-0000-0000-0000-000000000002";

const rows = [
  { user_id: "u1", event_type: OPTOUT_EVENT_TYPE, metadata: { claim_id: SUPPRESSED }, created_at: "2026-09-07T00:00:00Z" },
  { user_id: "u2", event_type: "next_steps_nudge_sent", metadata: { claim_id: ALLOWED, nudge_stage: "2h" }, created_at: "2026-09-06T00:00:00Z" },
  { user_id: "u2", event_type: "claim_created", metadata: { claim_id: ALLOWED }, created_at: "2026-09-05T00:00:00Z" },
];

Deno.test("one suppressed and one allowed claim, same run: exactly one is skipped", () => {
  const optedOut = collectOptedOutClaimIds(rows);
  assertEquals(optedOut.size, 1);
  // The suppressed one is skipped...
  assertEquals(isOptedOut(optedOut, SUPPRESSED), true);
  // ...and the other one on the SAME run is not. This pair is what rules out
  // both "suppresses everybody" and "suppresses nobody".
  assertEquals(isOptedOut(optedOut, ALLOWED), false);
});

Deno.test("NEGATIVE CONTROL — with no opt-out row present, nothing is suppressed", () => {
  const optedOut = collectOptedOutClaimIds(rows.filter((r) => r.event_type !== OPTOUT_EVENT_TYPE));
  assertEquals(optedOut.size, 0);
  assertEquals(isOptedOut(optedOut, SUPPRESSED), false);
});

Deno.test("only the opt-out event type suppresses — a nudge stamp does not", () => {
  const optedOut = collectOptedOutClaimIds([
    { user_id: "u3", event_type: "next_steps_nudge_sent", metadata: { claim_id: SUPPRESSED }, created_at: "x" },
  ]);
  assertEquals(optedOut.size, 0);
});

Deno.test("an opt-out row with no claim_id is ignored, not treated as a global stop", () => {
  const optedOut = collectOptedOutClaimIds([
    { user_id: "u4", event_type: OPTOUT_EVENT_TYPE, metadata: {}, created_at: "x" },
    { user_id: "u5", event_type: OPTOUT_EVENT_TYPE, metadata: null, created_at: "x" },
    { user_id: "u6", event_type: OPTOUT_EVENT_TYPE, metadata: { claim_id: "" }, created_at: "x" },
  ]);
  assertEquals(optedOut.size, 0);
  assertEquals(isOptedOut(optedOut, ALLOWED), false);
});

Deno.test("duplicate opt-out rows collapse to one claim", () => {
  const optedOut = collectOptedOutClaimIds([rows[0], rows[0], rows[0]]);
  assertEquals(optedOut.size, 1);
});

Deno.test("the CAN-SPAM gate fails CLOSED without a signing secret", () => {
  assertEquals(canSendWithOptOut("a-secret"), true);
  // NEGATIVE CONTROL — every falsy/absent form refuses the run.
  assertEquals(canSendWithOptOut(""), false);
  assertEquals(canSendWithOptOut(null), false);
  assertEquals(canSendWithOptOut(undefined), false);
});

// ─── PR #1810 LEGAL-READ FAIL (comment 5577311497) — fetchOptedOutClaimIds ──
// must survive PostgREST's server-side row cap, which the general
// (unfiltered, unbounded) activity_log read used elsewhere in index.ts
// cannot. These tests use a tiny fake PostgREST-shaped client that applies
// filters exactly like real Postgres does (WHERE narrows the row set FIRST,
// then a hard cap truncates the FILTERED result) — the same mechanism the
// live incident describes, just with a small cap (3) instead of the
// production default so the fixture stays readable.

/** A minimal fake of the Supabase/PostgREST query builder, filtering exactly
 * like `optout-filter.ts`'s real target (a plain equality/membership scan),
 * then truncating to `cap` rows — simulating PostgREST's row cap applying to
 * the FILTERED result set, which is what actually happens in Postgres (the
 * WHERE clause runs before any row limit). */
function fakePostgrest(allRows: readonly (ActivityRowLike & { user_id: string })[], cap: number): OptOutQueryClient {
  return {
    from(table: string) {
      if (table !== "activity_log") throw new Error(`unexpected table: ${table}`);
      return {
        select(_columns: string): OptOutFilterBuilder {
          let rows: readonly (ActivityRowLike & { user_id: string })[] = allRows;
          const builder: OptOutFilterBuilder = {
            eq(column: string, value: string) {
              rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[column] === value);
              return builder;
            },
            in(column: string, values: readonly string[]) {
              const wanted = new Set(values);
              if (column === "metadata->>claim_id") {
                rows = rows.filter((r) => {
                  const claimId = r.metadata?.claim_id;
                  return typeof claimId === "string" && wanted.has(claimId);
                });
              } else {
                rows = rows.filter((r) => wanted.has((r as unknown as Record<string, unknown>)[column] as string));
              }
              return builder;
            },
            then(onfulfilled, onrejected) {
              // The row cap applies HERE — after every filter above has
              // already narrowed `rows` — never to the raw table.
              const capped = rows.slice(0, cap);
              return Promise.resolve({ data: [...capped], error: null }).then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
    },
  };
}

const CAP = 3;
const U1 = "u1";
const SUPPRESSED_CLAIM = "cccccccc-0000-0000-0000-000000000009";

// 4 rows total for u1: 3 unrelated events (nudge stamps / claim_created) that
// sort before the opt-out row, then the opt-out row itself LAST — so a naive
// scan-and-cap without an event_type filter takes the 3 noise rows and drops
// the opt-out row that comes after them, exactly the "which rows survive is
// arbitrary" hazard named in the standing LEGAL-READ FAIL.
const rowsWithTruncationHazard: (ActivityRowLike & { user_id: string })[] = [
  { user_id: U1, event_type: "claim_created", metadata: { claim_id: "aaaa" }, created_at: "2026-09-01T00:00:00Z" },
  {
    user_id: U1,
    event_type: "next_steps_nudge_sent",
    metadata: { claim_id: "aaaa" },
    created_at: "2026-09-05T00:00:00Z",
  },
  {
    user_id: U1,
    event_type: "next_steps_nudge_sent",
    metadata: { claim_id: "bbbb" },
    created_at: "2026-09-06T00:00:00Z",
  },
  { user_id: U1, event_type: OPTOUT_EVENT_TYPE, metadata: { claim_id: SUPPRESSED_CLAIM }, created_at: "2026-09-07T00:00:00Z" },
];

Deno.test("CHARACTERIZATION — the OLD unfiltered shape (.in('user_id', ...) only) truncates the opt-out row out under the cap", async () => {
  // This reproduces the exact query shape the LEGAL-READ FAIL named:
  // `.from('activity_log').select(...).in('user_id', userIds)`, no
  // event_type filter, no order, no limit — then reduced the same way
  // index.ts used to, straight through collectOptedOutClaimIds.
  const client = fakePostgrest(rowsWithTruncationHazard, CAP);
  const { data } = await client.from("activity_log").select("user_id, event_type, metadata, created_at").in(
    "user_id",
    [U1],
  );
  const optedOut = collectOptedOutClaimIds((data || []) as ActivityRowLike[]);
  // FAILS to detect the opt-out: the cap (3) truncated the 4-row result
  // before the 4th row (the opt-out) was ever considered.
  assertEquals(optedOut.has(SUPPRESSED_CLAIM), false);
});

Deno.test("fetchOptedOutClaimIds survives the same cap: event_type + claim_id narrow the row set BEFORE the cap can truncate it", async () => {
  const client = fakePostgrest(rowsWithTruncationHazard, CAP);
  const { optedOut, error } = await fetchOptedOutClaimIds(client, [U1], [SUPPRESSED_CLAIM]);
  assertEquals(error, null);
  // PASSES: filtering to event_type=OPTOUT_EVENT_TYPE and
  // metadata->>claim_id IN (SUPPRESSED_CLAIM) narrows the 4-row table down to
  // exactly 1 matching row BEFORE the cap of 3 is applied, so it survives no
  // matter where in the underlying table it physically sits.
  assertEquals(optedOut.has(SUPPRESSED_CLAIM), true);
});

Deno.test("fetchOptedOutClaimIds: an allowed claim in the same batch is correctly NOT opted out (rules out 'suppresses everybody')", async () => {
  const client = fakePostgrest(rowsWithTruncationHazard, CAP);
  const { optedOut } = await fetchOptedOutClaimIds(client, [U1], [SUPPRESSED_CLAIM, "aaaa", "bbbb"]);
  assertEquals(optedOut.has(SUPPRESSED_CLAIM), true);
  assertEquals(optedOut.has("aaaa"), false);
  assertEquals(optedOut.has("bbbb"), false);
});

Deno.test("fetchOptedOutClaimIds: an empty candidate batch short-circuits without querying", async () => {
  let calledFrom = false;
  const client: OptOutQueryClient = {
    from(_table: string) {
      calledFrom = true;
      throw new Error("should not be called for an empty candidate batch");
    },
  };
  const { optedOut, error } = await fetchOptedOutClaimIds(client, ["u1"], []);
  assertEquals(optedOut.size, 0);
  assertEquals(error, null);
  assertEquals(calledFrom, false);
});

Deno.test("fetchOptedOutClaimIds: a query error is surfaced, not swallowed", async () => {
  const failingClient: OptOutQueryClient = {
    from(_table: string) {
      return {
        select(_columns: string): OptOutFilterBuilder {
          const builder: OptOutFilterBuilder = {
            eq() {
              return builder;
            },
            in() {
              return builder;
            },
            then(onfulfilled, onrejected) {
              return Promise.resolve({ data: null, error: { message: "connection reset" } }).then(
                onfulfilled,
                onrejected,
              );
            },
          };
          return builder;
        },
      };
    },
  };
  const { optedOut, error } = await fetchOptedOutClaimIds(failingClient, ["u1"], [SUPPRESSED_CLAIM]);
  assertEquals(optedOut.size, 0);
  assertEquals(error?.message, "connection reset");
});
