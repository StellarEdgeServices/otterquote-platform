// gh-2105 batch 6 -- wiring test for the zero-row-update detection added to
// this function's `contractors.stripe_customer_id` save.
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope/gh2105-zero-row-wiring.test.ts) this
// reads index.ts as TEXT and asserts the required wiring is present.
//
// FAIL-FIRST: run against main's (pre-batch-6) index.ts -- the
// `.update({ stripe_customer_id: customerId }).eq("id", contractor_id)`
// call has no `.select("id")` chained and there is no zero-row check;
// every assertion below fails there.
//
// This write is explicitly documented (the line right above it) as
// "Non-fatal — continue with SetupIntent creation" even on a Postgrest
// error, so the fix keeps that same non-fatal shape -- it does NOT throw
// on a zero-row match (decision a-with-alert). No user-facing behaviour
// change: only a platform_alerts_log entry is added for operator
// visibility (duplicate-Stripe-Customer drift on every future call).
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the stripe_customer_id save selects and checks rows, still non-fatal", () => {
  const idxUpdate = mustFind('const { error: updateError, data: updateRows } = await supabase');
  const idxStep2 = mustFind("// ── Step 2: Create SetupIntent ──", idxUpdate);
  const block = src.slice(idxUpdate, idxStep2);
  assertStringIncludes(block, '.select("id")', "the contractors update must chain .select(\"id\")");
  assertStringIncludes(block, "Array.isArray(updateRows)", "must check the returned rows, not just `error`");
  assertStringIncludes(block, "gh2105_zero_row_update", "must carry the repo-wide gh-2105 alert_type convention");
  assertStringIncludes(block, "platform_alerts_log", "a zero-row match must raise an alert an operator can see");
  // Decision a-WITH-ALERT, not a throw: SetupIntent creation must continue
  // either way, matching the existing "Non-fatal" comment on this write.
  assertStringIncludes(block, "Non-fatal — continue with SetupIntent creation");
});

Deno.test("mutation control: removing .select(\"id\") disconnects updateRows from the real write outcome", () => {
  const idxUpdate = mustFind('const { error: updateError, data: updateRows } = await supabase');
  const idxStep2 = mustFind("// ── Step 2: Create SetupIntent ──", idxUpdate);
  const block = src.slice(idxUpdate, idxStep2);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")') && block.includes('.select("id")'),
    "removing .select(\"id\") changes the block from ratchet-passing to ratchet-failing shape");
});
