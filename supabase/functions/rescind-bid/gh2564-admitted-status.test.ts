// gh-2564: rescind-bid must write a bid_status that production's check constraint admits.
//
// Production quotes_bid_status_check, read 2026-10-13 (SELECT on pg_constraint):
//   CHECK ((bid_status = ANY (ARRAY['active'::text, 'expired'::text, 'superseded'::text, 'cancelled'::text])))
// The constraint is simulated below from that literal text, so the test fails for any value the real one refuses.
// NEGATIVE CONTROL: the old write, 'rescinded', is refused by the same simulator (23514), and a source-text check
// fails against the pre-fix index.ts.
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RESCINDABLE_STATUSES, RESCINDED_BID_STATUS } from "./status.ts";

const LIVE_CONSTRAINT_DEF =
  "CHECK ((bid_status = ANY (ARRAY['active'::text, 'expired'::text, 'superseded'::text, 'cancelled'::text])))";

function admittedValues(def: string): string[] {
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
}

// A one-column stand-in for public.quotes: UPDATE throws 23514 for a value the constraint does not admit.
class SimulatedQuotes {
  row: { bid_status: string } = { bid_status: "active" };
  constructor(private admitted: string[]) {}
  update(patch: { bid_status: string }) {
    if (!this.admitted.includes(patch.bid_status)) {
      const e = new Error(`new row for relation "quotes" violates check constraint "quotes_bid_status_check"`);
      (e as Error & { code: string }).code = "23514";
      throw e;
    }
    this.row = { ...this.row, ...patch };
  }
}

const admitted = admittedValues(LIVE_CONSTRAINT_DEF);
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("the simulator reads the four live values", () => {
  assertEquals(admitted, ["active", "expired", "superseded", "cancelled"]);
});

Deno.test("NEGATIVE CONTROL: the old 'rescinded' write is refused 23514", () => {
  const q = new SimulatedQuotes(admitted);
  const err = assertThrows(() => q.update({ bid_status: "rescinded" })) as Error & { code: string };
  assertEquals(err.code, "23514");
  assertEquals(q.row.bid_status, "active");
});

Deno.test("the value rescind-bid writes now is admitted, and the bid is no longer live", () => {
  const q = new SimulatedQuotes(admitted);
  q.update({ bid_status: RESCINDED_BID_STATUS });
  assertEquals(q.row.bid_status, "cancelled");
  // The award guards (gh2626 draft) call a quote live only when bid_status is 'active' or NULL.
  assert(q.row.bid_status !== "active");
});

Deno.test("every status rescind-bid accepts as rescindable that the constraint can hold is a live one", () => {
  // 'active' is the only rescindable value the constraint admits; the others are legacy names kept as-is.
  assertEquals(RESCINDABLE_STATUSES.filter((s) => admitted.includes(s)), ["active"]);
});

Deno.test("wiring: index.ts writes RESCINDED_BID_STATUS, not a string literal, and never 'rescinded'", () => {
  assert(src.includes('import { RESCINDABLE_STATUSES, RESCINDED_BID_STATUS } from "./status.ts";'));
  assert(/\.update\(\{\s*bid_status: RESCINDED_BID_STATUS,/.test(src), "the update must write RESCINDED_BID_STATUS");
  assert(!/bid_status:\s*["']rescinded["']/.test(src));
});

Deno.test("mutation control: the pre-fix source text fails the wiring check", () => {
  const preFix = src.replace("bid_status: RESCINDED_BID_STATUS,", 'bid_status: "rescinded",');
  assert(!/\.update\(\{\s*bid_status: RESCINDED_BID_STATUS,/.test(preFix));
  assert(/bid_status:\s*["']rescinded["']/.test(preFix));
});
