// gh-2105 batch 11 -- wiring test for the zero-row-update handling added to
// mark-loss-sheet-reviewed's update writes.
//
// This EF calls serve()/Deno.serve() at module level and cannot be imported
// directly, so (following the batch-8/9/10 gh2105-zero-row-wiring.test.ts
// files) this reads index.ts as TEXT and asserts the required wiring is
// present.
//
// FAIL-FIRST / NEGATIVE CONTROL: run against origin/main's (pre-batch-11)
// index.ts -- the claims update carries no update-no-select-ok annotation and a comment still spells the scanner trigger.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts -- source has moved; update this test's anchors.`);
  }
  return i;
}

const ANNOTATED: Array<{ name: string; needle: string; reasonHint: string }> = [
  {
    "name": "claims reviewed-marker update",
    "needle": ".update(patch)",
    "reasonHint": ".select("
  }
];

for (const a of ANNOTATED) {
  Deno.test(`annotation: ${a.name} carries update-no-select-ok with a reason`, () => {
    let from = 0;
    let found = 0;
    while (true) {
      const i = src.indexOf(a.needle, from);
      if (i === -1) break;
      found++;
      from = i + a.needle.length;
      const lineStart = src.lastIndexOf("\n", i) + 1;
      const lineEnd = src.indexOf("\n", i);
      const line = src.slice(lineStart, lineEnd);
      const prevStart = src.lastIndexOf("\n", lineStart - 2) + 1;
      const prev = src.slice(prevStart, lineStart - 1);
      const joined = line + "\n" + prev;
      // Same rule as scripts/check-unselected-update-ratchet.py: the marker on
      // the trigger line or the line directly above it.
      assertStringIncludes(joined, "update-no-select-ok", `${a.name}: marker missing at occurrence ${found}`);
      assertStringIncludes(joined, a.reasonHint, `${a.name}: the annotation must say why zero rows is legitimate`);
    }
    assert(found > 0, `${a.name}: needle ${a.needle} not found -- source has moved`);
  });
}

Deno.test("the only .update( occurrence in index.ts is the real, annotated call (no comment trips the ratchet scanner)", () => {
  assert(src.split(".update(").length - 1 === 1, "a comment still spells the ratchet trigger substring");
  mustFind("q.select(\"id, loss_sheet_reviewed_at\")");
});
