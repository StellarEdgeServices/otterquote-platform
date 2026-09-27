// gh-2105 batch 7 -- wiring test for the zero-row-update detection added to
// this function's single write: contractors.wc_cert_uploaded_at (wce1_exempt)
// or contractors.license_attestation_signed_at (no_license_required).
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope's gh2105-zero-row-wiring.test.ts /
// template-invariant-wiring.test.ts pattern in this repo) this reads
// index.ts as TEXT and asserts the actual source contains the required
// wiring, not a mocked stand-in for it.
//
// FAIL-FIRST: run against origin/k72/gh2105-batch6's (pre-batch-7) index.ts
// -- every mustFind() below throws "source has moved" because none of this
// wiring exists yet: the update is a bare
// `await supabase.from("contractors").update(updateData).eq("id", contractor_id);`
// with no `.select()` and no zero-row check. On this branch, all
// assertions resolve.
//
// Unlike create-docusign-envelope's fire-and-forget writes, this one is
// DECISION (a) -- a full fail, matching this file's own existing
// `updateError` branch's 500 response shape. A WCE-1 exemption or
// no-license attestation is a legal compliance record: reporting
// `success: true` while it never actually persisted would let a contractor
// bid believing they are covered when the database says otherwise.
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
    "must reuse the batch-2 shared guard, not a bespoke local copy",
  );
});

Deno.test("wiring: the contractors update selects and checks rows written", () => {
  const idxUpdate = mustFind('.from("contractors")\n    .update(updateData)');
  const idxLog = mustFind('const { error: logError }', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  assertStringIncludes(block, '.select("id")', 'must chain .select("id") to prove a row actually matched');
  assertStringIncludes(block, "checkRowsWritten(updateRows).wroteRows");
  assertStringIncludes(block, "zeroRowWriteMessage(");
});

Deno.test("wiring: a zero-row match returns a 500 with the gh2105_zero_rows sentinel — decision (a), full fail", () => {
  const idxUpdate = mustFind('.from("contractors")\n    .update(updateData)');
  const idxLog = mustFind('const { error: logError }', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  assertStringIncludes(block, "gh2105_zero_rows");
  assertStringIncludes(block, "jsonResponse(");
  assertStringIncludes(block, "500");
  // Must reuse the SAME response field names as the pre-existing updateError
  // branch just above it, so the client-side error handling shape is unchanged.
  assertStringIncludes(block, '"Failed to record attestation"');
});

Deno.test("mutation control: removing .select(\"id\") disconnects checkRowsWritten's input from the real write outcome", () => {
  const idxUpdate = mustFind('.from("contractors")\n    .update(updateData)');
  const idxLog = mustFind('const { error: logError }', idxUpdate);
  const block = src.slice(idxUpdate, idxLog);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")'), "mutation setup sanity check");
  assert(
    !mutated.includes('.select("id")') && block.includes('.select("id")'),
    'removing .select("id") changes the block from ratchet-passing to ratchet-failing shape',
  );
});
