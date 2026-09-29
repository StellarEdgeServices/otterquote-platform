// gh-2105 batch 6 -- wiring test for the zero-row-update detection added to
// this function's `referral_agents` write (clears payments_blocked,
// records the W-9 submission).
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope/gh2105-zero-row-wiring.test.ts in the
// sibling directory) this reads index.ts as TEXT and asserts the required
// wiring is present.
//
// FAIL-FIRST: run against main's (pre-batch-6) index.ts -- the
// `.update({...}).eq("id", agent.id)` call has no `.select("id")` chained
// and there is no zero-row check; every assertion below fails there.
//
// This write is decision (a) WITH throw (like the existing uploadErr/
// updateErr branches it sits next to): a zero-row match here means
// "W-9 submitted successfully. Your payment will be processed..." would be
// returned while payments_blocked stays true and no W-9 is on file -- the
// exact failure mode this endpoint exists to prevent. A real behaviour
// change on a money/legal path, flagged for R-177 on the PR, not decided
// here.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the referral_agents update (payments_blocked clear + W-9 record) selects and checks rows", () => {
  const idxUpdate = mustFind('const { error: updateErr, data: updateRows } = await sbAdmin');
  const idxLog = mustFind('submit-partner-w9: W-9 submitted for agent_id=', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  assertStringIncludes(block, '.select("id")', "the referral_agents update must chain .select(\"id\")");
  assertStringIncludes(block, "Array.isArray(updateRows)", "must check the returned rows, not just `error`");
  assertStringIncludes(block, "gh2105_zero_rows", "must carry the repo-wide gh-2105 sentinel");
  // The zero-row branch must throw (decision a), same as updateErr right above it.
  assertStringIncludes(block, "throw new Error(\"gh2105_zero_rows", "a zero-row match must fail the request, not silently succeed");
});

Deno.test("wiring: the zero-row branch cleans up the uploaded file, same as the existing updateErr branch", () => {
  const idxUpdate = mustFind('const { error: updateErr, data: updateRows } = await sbAdmin');
  const idxLog = mustFind('submit-partner-w9: W-9 submitted for agent_id=', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  const removeCount = (block.match(/\.remove\(\[storagePath\]\)/g) || []).length;
  assert(removeCount === 2, `expected the storage cleanup to run in BOTH the updateErr branch and the new zero-row branch, found ${removeCount} call(s)`);
});

Deno.test("mutation control: removing .select(\"id\") disconnects updateRows from the real write outcome", () => {
  const idxUpdate = mustFind('const { error: updateErr, data: updateRows } = await sbAdmin');
  const idxLog = mustFind('submit-partner-w9: W-9 submitted for agent_id=', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")') && block.includes('.select("id")'),
    "removing .select(\"id\") changes the block from ratchet-passing to ratchet-failing shape");
});
