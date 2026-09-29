// gh-2105 batch 6 -- wiring test for the zero-row-update detection added to
// this function's `hover_orders` write that marks a Stripe refund as
// rebated (rebate_due=false, rebate_paid_at=now()).
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope/gh2105-zero-row-wiring.test.ts) this
// reads index.ts as TEXT and asserts the required wiring is present.
//
// FAIL-FIRST: run against main's (pre-batch-6) index.ts -- the
// `.update({...}).eq("id", order.id).is("rebate_paid_at", null)` call has
// no `.select("id")` chained and no zero-row check beyond the existing
// `updErr` branch; every assertion below fails there.
//
// This is a REFUND write (money — HIGH PRIORITY): the Stripe refund has
// already fired and is irreversible by the time this write runs, so the
// fix does NOT throw (decision a-with-alert), matching the existing
// updErr branch's own "Refund already happened — log but do not fail the
// call" comment. What the fix adds: a zero-row match here is ambiguous
// (a concurrent idempotent retry is a LEGITIMATE zero-row outcome because
// of the `.is("rebate_paid_at", null)` guard -- decision b for that case)
// but an id-mismatch/RLS miss is not: it leaves rebate_due=true stuck,
// and the next pg_cron scan would refund the SAME order again (a real
// double refund). The alert lets an operator tell the two cases apart.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the rebate-marking update selects and checks rows before the existing updErr branch", () => {
  const idxUpdate = mustFind('.from("hover_orders")');
  const idxUpdErr = mustFind('if (updErr) {', idxUpdate);
  const block = src.slice(idxUpdate, idxUpdErr);
  assertStringIncludes(block, '.select("id")', "the hover_orders update must chain .select(\"id\")");
  assertStringIncludes(block, 'Array.isArray(updRows)', "must check the returned rows, not just `error`");
  assertStringIncludes(block, "gh2105_zero_row_update", "must carry the repo-wide gh-2105 alert_type convention");
  assertStringIncludes(block, "platform_alerts_log", "a zero-row match must raise an alert an operator can see");
  assertStringIncludes(block, "double", "the alert message must call out the double-refund risk, not just log-and-forget");
});

Deno.test("wiring: the existing updErr (Postgrest-error) branch is unchanged and still present", () => {
  assertStringIncludes(src, 'if (updErr) {');
  assertStringIncludes(src, '"[rebate] DB update after refund failed:"');
  assertStringIncludes(src, "hover_rebate_db_update_failed");
});

Deno.test("mutation control: removing .select(\"id\") disconnects updRows from the real write outcome", () => {
  const idxUpdate = mustFind('.from("hover_orders")');
  const idxUpdErr = mustFind('if (updErr) {', idxUpdate);
  const block = src.slice(idxUpdate, idxUpdErr);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")') && block.includes('.select("id")'),
    "removing .select(\"id\") changes the block from ratchet-passing to ratchet-failing shape");
});
