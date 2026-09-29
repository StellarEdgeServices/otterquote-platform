// gh-2105 batch 10 -- wiring test for the zero-row-update detection added to
// process-coi-reminders's update writes.
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following the batch-8/9 gh2105-zero-row-wiring.test.ts files) this reads
// index.ts as TEXT and asserts the required wiring is present.
//
// FAIL-FIRST / NEGATIVE CONTROL: run against main's (pre-batch-10) index.ts --
// none of the update calls below chains .select("id"), the shared guard is
// not imported and no zero-row check exists; every wiring assertion fails.
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

const SITES: Array<{ name: string; start: string; end: string; must: string[] }> = [
  {
    "name": "suspend update",
    "start": "const { error: suspendError, data: suspendRows }",
    "end": "const expiredEmail = buildExpiredEmail",
    "must": [
      "suspendRows",
      "result.errors.push(msg)",
      "continue;"
    ]
  },
  {
    "name": "7-day stamp",
    "start": "coi_reminder_7_sent_at: now",
    "end": "7-day COI reminder sent",
    "must": [
      "stampRows",
      "result.errors.push("
    ]
  },
  {
    "name": "14-day stamp",
    "start": "coi_reminder_14_sent_at: now",
    "end": "14-day COI reminder sent",
    "must": [
      "stampRows",
      "result.errors.push("
    ]
  },
  {
    "name": "30-day stamp",
    "start": "coi_reminder_30_sent_at: now",
    "end": "30-day COI reminder sent",
    "must": [
      "stampRows",
      "result.errors.push("
    ]
  },
  {
    "name": "WC 30-day stamp",
    "start": "wc_cert_reminder_30_sent_at: now",
    "end": "30-day WC reminder sent",
    "must": [
      "stampRows",
      "result.errors.push("
    ]
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
