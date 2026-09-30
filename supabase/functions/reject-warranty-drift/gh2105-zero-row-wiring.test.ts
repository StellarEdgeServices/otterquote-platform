// gh-2105 batch 11 -- wiring test for the zero-row-update handling added to
// reject-warranty-drift's update writes.
//
// This EF calls serve()/Deno.serve() at module level and cannot be imported
// directly, so (following the batch-8/9/10 gh2105-zero-row-wiring.test.ts
// files) this reads index.ts as TEXT and asserts the required wiring is
// present.
//
// FAIL-FIRST / NEGATIVE CONTROL: run against origin/main's (pre-batch-11)
// index.ts -- the drift-status update chains no .select("id"), the shared guard is not imported and no zero-row check exists.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts -- source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the shared zero-row guard is imported", () => {
  assertStringIncludes(src, 'from "../_shared/zero-row-update-guard.ts"');
  assertStringIncludes(src, "checkRowsWritten(");
});

const SITES: Array<{ name: string; start: string; end: string; must: string[]; mustNot: string[] }> = [
  {
    "name": "drift status update",
    "start": "const { error: updateErr, data: updateRows }",
    "end": "// Log activity",
    "must": [
      "updateRows",
      "throw new Error(zeroRowWriteMessage("
    ],
    "mustNot": []
  }
];

for (const site of SITES) {
  Deno.test(`wiring: ${site.name} selects and checks rows`, () => {
    const i = mustFind(site.start);
    const j = mustFind(site.end, i);
    const block = src.slice(i, j);
    assertStringIncludes(block, '.select("id")', `${site.name}: the update must chain .select("id")`);
    assertStringIncludes(block, "checkRowsWritten(", `${site.name}: must check the returned rows, not just \`error\``);
    assertStringIncludes(block, "zeroRowWriteMessage(", `${site.name}: the zero-row branch must use the shared gh-2105 message`);
    for (const m of site.must) assertStringIncludes(block, m, `${site.name}: missing ${m}`);
    for (const m of site.mustNot) assert(!block.includes(m), `${site.name}: must not contain ${m}`);
  });

  Deno.test(`mutation control: removing .select("id") from ${site.name} breaks the wiring`, () => {
    const i = mustFind(site.start);
    const j = mustFind(site.end, i);
    const block = src.slice(i, j);
    const mutated = block.replaceAll('.select("id")', "");
    assert(block.includes('.select("id")') && !mutated.includes('.select("id")'),
      "removing .select(\"id\") turns this site back into the ratchet-failing shape (scripts/check-unselected-update-ratchet.py)");
  });
}
