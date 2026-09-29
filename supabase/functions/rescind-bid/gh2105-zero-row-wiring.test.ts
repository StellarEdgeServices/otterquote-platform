// gh-2105 batch 6 -- wiring test for the zero-row-update detection added to
// this function's `quotes.bid_status = 'rescinded'` write.
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope/gh2105-zero-row-wiring.test.ts /
// template-invariant-wiring.test.ts in the sibling directories) this reads
// index.ts as TEXT and asserts the actual source contains the required
// wiring.
//
// FAIL-FIRST: run against main's (pre-batch-6) index.ts -- the
// `.update({...}).eq("id", body.quote_id)` call has no `.select("id")`
// chained and there is no zero-row check; every mustFind()/assert below
// fails there.
//
// Unlike batch 5's docusign envelope-pointer writes, this one is NOT
// fire-and-forget: it is this endpoint's own primary write, and `quote`
// was already fetched earlier by this same id, so a zero-row match means
// the row changed out from under the request. The fix returns an error
// response (409) instead of `success: true` -- a real behaviour change on
// a money path, flagged for R-177 on the PR, not decided here.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the quote rescission update selects and checks rows", () => {
  const idxUpdate = mustFind('const { error: updateError, data: updateRows } = await supabase');
  const idxActivity = mustFind("// Insert activity log entry", idxUpdate);
  const block = src.slice(idxUpdate, idxActivity);
  assertStringIncludes(block, '.select("id")', "the rescission update must chain .select(\"id\")");
  assertStringIncludes(block, "Array.isArray(updateRows)", "must check the returned rows, not just `error`");
  assertStringIncludes(block, "gh2105_zero_rows", "the zero-row branch must carry the repo-wide gh-2105 sentinel");
  assertStringIncludes(block, "status: 409", "a zero-row match must be reported as an error to the caller, not success");
});

Deno.test("wiring: the updateError branch (Postgrest error) is unchanged and still present", () => {
  assertStringIncludes(src, 'if (updateError) {');
  assertStringIncludes(src, 'JSON.stringify({ error: "Failed to rescind bid", details: updateError }');
});

Deno.test("mutation control: removing .select(\"id\") disconnects updateRows from the real write outcome", () => {
  const idxUpdate = mustFind('const { error: updateError, data: updateRows } = await supabase');
  const idxActivity = mustFind("// Insert activity log entry", idxUpdate);
  const block = src.slice(idxUpdate, idxActivity);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")') && block.includes('.select("id")'),
    "removing .select(\"id\") changes the block from ratchet-passing to ratchet-failing shape (caught by scripts/check-unselected-update-ratchet.py in CI)");
});
