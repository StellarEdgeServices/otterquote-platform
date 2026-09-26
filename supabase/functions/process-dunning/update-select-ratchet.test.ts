// gh-2105 (batch 3) -- static regression guard for this function's part of
// the #2103/gh-2105 defect class. Unit tests for the pure zero-row-update
// helpers live in `supabase/functions/_shared/zero-row-update-guard.test.ts`
// (batch 2, PR #2210) -- this file does NOT duplicate those. It only pins
// that every `.update(` call site in THIS function's index.ts chains
// `.select(` nearby, as a file-local, faster-to-read twin of
// `scripts/check-unselected-update-ratchet.py`'s repo-wide sweep.
//
// NEGATIVE CONTROL: before batch 3, none of index.ts's un-selected `.update(`
// call sites chained `.select(`, so this assertion is RED against that tree
// (it lists real pre-fix line numbers) and GREEN on this branch. See PR
// #2217's body for both raw outputs.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("index.ts: every .update( call chains .select( within the next 10 lines", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const offenders: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!line.includes(".update(")) continue;
    if (trimmed.startsWith("//")) continue; // comment mentioning .update(
    const window = lines.slice(i, i + 10).join("\n");
    if (!window.includes(".select(")) offenders.push(i + 1);
  }
  assertEquals(offenders, [], `un-selected .update( at line(s): ${offenders.join(", ")}`);
});
