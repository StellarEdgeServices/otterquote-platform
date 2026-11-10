// gh-3586 wiring test: index.ts cannot be imported (serve() at module level), so read it as TEXT, as gh2105-zero-row-wiring.test.ts does.
// FAIL-FIRST / NEGATIVE CONTROL: on origin/main index.ts has no Phase 6.
import { assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts imports the gap check and runs Phase 6 through fireAlert", () => {
  assertStringIncludes(src, 'from "./fee-acceptance-gap-check.ts"');
  assertStringIncludes(src, "runFeeAcceptanceGapCheck(");
  assertStringIncludes(src, "evaluateFeeAcceptanceGap(");
  assertStringIncludes(src, "feeAcceptanceGapCount");
});

Deno.test("Phase 6 reads fee_acceptances by bid_id and quotes without writing either", () => {
  const start = src.indexOf("async function runFeeAcceptanceGapCheck");
  if (start === -1) throw new Error("runFeeAcceptanceGapCheck missing");
  const body = src.slice(start, src.indexOf("// MAIN HANDLER", start));
  assertStringIncludes(body, '.from("fee_acceptances")');
  assertStringIncludes(body, '.from("quotes")');
  for (const w of [".insert(", ".update(", ".delete(", ".upsert("]) {
    if (body.includes(w)) throw new Error(`Phase 6 must be read-only; found ${w}`);
  }
});
