// gh-2105 batch 8 -- wiring test for the zero-row-update detection added to
// the superseded, cap-path expired, standard expired and bid_window_notified_at writes.
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following create-docusign-envelope/gh2105-zero-row-wiring.test.ts in the
// sibling directory) this reads index.ts as TEXT and asserts the required
// wiring is present.
//
// FAIL-FIRST: run against main's (pre-batch-8) index.ts -- none of the update
// calls below chains `.select("id")`, the shared guard is not imported and no
// zero-row check exists; every wiring assertion fails there.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
// gh-3848: the superseded write moved to renewal-swap.ts (supersede first, then insert the clone).
const swapSrc = await Deno.readTextFile(new URL("./renewal-swap.ts", import.meta.url));

function mustFind(needle: string, from = 0, text = src): number {
  const i = text.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts -- source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the shared zero-row guard is imported", () => {
  assertStringIncludes(src, 'from "../_shared/zero-row-update-guard.ts"');
  assertStringIncludes(src, "checkRowsWritten(");
});

const SITES: Array<{ name: string; file?: "swap"; start: string; end: string; must: string[] }> = [
  {
    "name": "superseded update",
    "file": "swap",
    "start": "const { error: supersedeErr, data: supersedeRows }",
    "end": "// 2. Insert the renewal clone.",
    "must": [
      "supersedeRows",
      "errors.push("
    ]
  },
  {
    "name": "cap-path expired update",
    "start": "const { error: capExpireErr, data: capExpireRows }",
    "end": "notification_type: \"bid_renewal_cap_reached\"",
    "must": [
      "capExpireRows",
      "errors.push("
    ]
  },
  {
    "name": "standard expired update",
    "start": "const { error: updateError, data: expireRows }",
    "end": "// Contractor dashboard notification\n    try {\n      await supabase.from(\"notifications\").insert({\n        user_id:           contractor.user_id,\n        claim_id:          quote.claim_id,\n        notification_type: \"bid_expired\"",
    "must": [
      "expireRows",
      "continue;"
    ]
  },
  {
    "name": "bid_window_notified_at update",
    "start": "const { error: updateError, data: notifiedRows }",
    "end": "// Dashboard notification",
    "must": [
      "notifiedRows",
      "continue;"
    ]
  }
];

for (const site of SITES) {
  Deno.test(`wiring: ${site.name} selects and checks rows`, () => {
    const text = site.file === "swap" ? swapSrc : src;
    const i = mustFind(site.start, 0, text);
    const j = mustFind(site.end, i, text);
    const block = text.slice(i, j);
    assertStringIncludes(block, '.select("id")', `${site.name}: the update must chain .select("id")`);
    assertStringIncludes(block, "checkRowsWritten(", `${site.name}: must check the returned rows, not just \`error\``);
    assertStringIncludes(block, "zeroRowWriteMessage(", `${site.name}: the zero-row branch must use the shared gh-2105 message`);
    for (const m of site.must) assertStringIncludes(block, m, `${site.name}: missing ${m}`);
  });

  Deno.test(`mutation control: removing .select("id") from ${site.name} breaks the wiring`, () => {
    const text = site.file === "swap" ? swapSrc : src;
    const i = mustFind(site.start, 0, text);
    const j = mustFind(site.end, i, text);
    const block = text.slice(i, j);
    const mutated = block.replaceAll('.select("id")', "");
    assert(block.includes('.select("id")') && !mutated.includes('.select("id")'),
      "removing .select(\"id\") turns this site back into the ratchet-failing shape (scripts/check-unselected-update-ratchet.py)");
  });
}
