// gh-1759 wiring test: index.ts cannot be imported (serve() at module level), so read it as TEXT, as gh3586-fee-gap-wiring.test.ts does.
// FAIL-FIRST / NEGATIVE CONTROL: on origin/main index.ts has no Phase 7.
import { assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = src.indexOf("async function runChargedFeeChargeIdCheck");
const body = start === -1 ? "" : src.slice(start, src.indexOf("// MAIN HANDLER", start));

Deno.test("index.ts imports the check and runs Phase 7 through the existing fireAlert", () => {
  assertStringIncludes(src, 'from "./charged-fee-no-charge-id-check.ts"');
  assertStringIncludes(src, "runChargedFeeChargeIdCheck(");
  assertStringIncludes(src, "evaluateChargedFeeWithoutChargeId(");
  assertStringIncludes(src, "chargedFeeNoChargeIdCount");
  if (start === -1) throw new Error("runChargedFeeChargeIdCheck missing");
  assertStringIncludes(body, "fireAlert(");
});

Deno.test("Phase 7 reads claims with the forward-guard predicate, excludes is_test, and is read-only", () => {
  assertStringIncludes(body, '.from("claims")');
  assertStringIncludes(body, '.eq("platform_fee_charged", true)');
  assertStringIncludes(body, '.is("platform_fee_stripe_id", null)');
  assertStringIncludes(body, 'is_test.is.null,is_test.eq.false');
  for (const w of [".insert(", ".update(", ".delete(", ".upsert("]) {
    if (body.includes(w)) throw new Error(`Phase 7 must be read-only; found ${w}`);
  }
});
