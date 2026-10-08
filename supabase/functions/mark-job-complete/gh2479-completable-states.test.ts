// gh-2479 (CTO ruling 6049009981, route E3p/E3q): mark-job-complete completes a claim only from
// 'contract_signed'. This EF calls serve() at the bottom and cannot be imported, so (the same
// pattern as gh2105-zero-row-wiring.test.ts in this directory) the source is read as TEXT.
//
// FAIL-FIRST: on main COMPLETABLE_STATES is ["contract_signed", "awarded"], so the first two
// tests fail there. The third pins the guard's position so the constant cannot be left unused.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function completableStates(): string[] {
  const m = /const COMPLETABLE_STATES\s*=\s*(\[[^\]]*\])\s*;/.exec(src);
  if (!m) throw new Error("COMPLETABLE_STATES declaration not found in index.ts -- update this test's anchor.");
  return JSON.parse(m[1]);
}

Deno.test("gh-2479: only contract_signed is completable", () => {
  assertEquals(completableStates(), ["contract_signed"]);
});

Deno.test("gh-2479: awarded (and every pre-signing state) is not completable", () => {
  const states = completableStates();
  for (const s of ["awarded", "bidding", "draft", "submitted", "active", "documents_needed", "waitlisted"]) {
    assert(!states.includes(s), `'${s}' must not be a completable claim status`);
  }
});

Deno.test("gh-2479: the 409 state guard uses the constant, before the completion_date write", () => {
  const guard = src.indexOf("if (!COMPLETABLE_STATES.includes(claim.status))");
  const write = src.indexOf('.update({ completion_date: completionDate })');
  assert(guard !== -1, "state guard not found");
  assert(write !== -1, "completion_date write not found");
  assert(guard < write, "the state guard must run before the completion_date write");
  assertStringIncludes(src, "}, 409, corsHeaders);");
});
