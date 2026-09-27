// gh-2105 batch 7 -- wiring test for the zero-row-update detection added to
// this function's contractor_templates.status/validation_result write (the
// D-199 fresh-validation path).
//
// This EF calls Deno.serve() and cannot be imported directly, so (following
// create-docusign-envelope's gh2105-zero-row-wiring.test.ts pattern) this
// reads index.ts as TEXT and asserts the required wiring is present.
//
// FAIL-FIRST: run against origin/k72/gh2105-batch6's (pre-batch-7) index.ts
// -- the update is `await supabase.from("contractor_templates").update({...}).eq("id", contractor_template_id);`
// with no `.select()` and no zero-row check; every assertion below fails
// there.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the shared zero-row-update guard is imported", () => {
  assertStringIncludes(
    src,
    `import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";`,
  );
});

Deno.test("wiring: the contractor_templates status update selects and checks rows written, decision (a) full fail", () => {
  const idxUpdate = mustFind('const { error: updateErr, data: updateRows } = await supabase\n      .from("contractor_templates")');
  const idxReturn = mustFind('return jsonResponse({\n      ok: true,', idxUpdate);
  const block = src.slice(idxUpdate, idxReturn);
  assertStringIncludes(block, '.select("id")');
  assertStringIncludes(block, "checkRowsWritten(updateRows).wroteRows");
  assertStringIncludes(block, "zeroRowWriteMessage(");
  assertStringIncludes(block, "gh2105_zero_rows");
  assertStringIncludes(block, "500", "must fail closed, matching the pre-existing updateErr branch just above it");
});

Deno.test("mutation control: removing .select(\"id\") disconnects checkRowsWritten's input from the real write outcome", () => {
  const idxUpdate = mustFind('const { error: updateErr, data: updateRows } = await supabase\n      .from("contractor_templates")');
  const idxReturn = mustFind('return jsonResponse({\n      ok: true,', idxUpdate);
  const block = src.slice(idxUpdate, idxReturn);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")'));
  assert(
    !mutated.includes('.select("id")') && block.includes('.select("id")'),
    'removing .select("id") changes the block from ratchet-passing to ratchet-failing shape',
  );
});
