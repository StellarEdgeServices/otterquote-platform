// gh-2559 / D-371: a bidding contractor is not given the job's street address.
// Run: deno test --allow-read=supabase/functions supabase/functions/get-hover-siding-data/

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { jobAddressFor, mayReceiveJobAddress } from "./job-address.ts";

// deno-lint-ignore no-explicit-any
function stub(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      // deno-lint-ignore no-explicit-any
      const filters: Array<(r: any) => boolean> = [];
      const b = {
        select() { return b; },
        // deno-lint-ignore no-explicit-any
        eq(col: string, val: unknown) { filters.push((r: any) => r[col] === val); return b; },
        maybeSingle() {
          return Promise.resolve({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        then(resolve: (v: { data: any[]; error: null }) => void) {
          resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return b;
    },
  };
}

const OWNER = { id: "owner-1" };
const CALLER = { id: "contractor-user-1" };
const ADDRESS = "999 Proofstreet Rd, Proofville, IN 46000";

function tables(selected: string | null, contractors: unknown[]) {
  return {
    claims: [{ id: "claim-1", user_id: OWNER.id, ready_for_bids: true, status: "bidding", selected_contractor_id: selected }],
    contractors: contractors as any[],
  };
}

Deno.test("the claim's owner is given the address", async () => {
  assertEquals(await mayReceiveJobAddress(stub(tables(null, [])), "claim-1", OWNER), true);
});

Deno.test("an active contractor bidding on an open claim, nobody selected, is NOT given the address", async () => {
  const t = tables(null, [{ id: "k1", user_id: CALLER.id, status: "active" }]);
  const may = await mayReceiveJobAddress(stub(t), "claim-1", CALLER);
  assertEquals(may, false);
  assertEquals(jobAddressFor(may, ADDRESS), null);
});

Deno.test("a bidder is NOT given the address when another contractor is selected", async () => {
  const t = tables("k-selected", [{ id: "k1", user_id: CALLER.id, status: "active" }]);
  assertEquals(await mayReceiveJobAddress(stub(t), "claim-1", CALLER), false);
});

Deno.test("the selected contractor, active, is given the address", async () => {
  const t = tables("k-selected", [{ id: "k-selected", user_id: CALLER.id, status: "active" }]);
  const may = await mayReceiveJobAddress(stub(t), "claim-1", CALLER);
  assertEquals(may, true);
  assertEquals(jobAddressFor(may, ADDRESS), ADDRESS);
});

Deno.test("the selected contractor record, not active, is NOT given the address", async () => {
  const t = tables("k-selected", [{ id: "k-selected", user_id: CALLER.id, status: "suspended" }]);
  assertEquals(await mayReceiveJobAddress(stub(t), "claim-1", CALLER), false);
});

Deno.test("an unknown claim and a user with no contractor record are refused", async () => {
  assertEquals(await mayReceiveJobAddress(stub(tables(null, [])), "no-such-claim", CALLER), false);
  assertEquals(await mayReceiveJobAddress(stub(tables("k-selected", [])), "claim-1", CALLER), false);
});

Deno.test("jobAddressFor fails closed on anything but true", () => {
  assertEquals(jobAddressFor(false, ADDRESS), null);
  // deno-lint-ignore no-explicit-any
  assertEquals(jobAddressFor(undefined as any, ADDRESS), null);
  assertEquals(jobAddressFor(true, null), null);
});
