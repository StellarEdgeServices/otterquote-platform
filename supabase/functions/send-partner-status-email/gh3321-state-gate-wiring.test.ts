// gh-3321 wiring test: send-partner-status-email must read claims.property_state and apply the no-fee-state gate
// before the stage stamp. Source-reading test, same pattern as process-payout-reminders/gh2105-zero-row-wiring.test.ts.
// Run: deno test --allow-read supabase/functions/send-partner-status-email/gh3321-state-gate-wiring.test.ts
import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("claim lookup selects property_state", () => {
  assert(/\.select\("id, selected_contractor_id, contract_signed_at, completion_date, property_state"\)/.test(src));
});
Deno.test("the gate is applied, and before the stage stamp (so a suppressed stage burns nothing)", () => {
  const gate = src.indexOf("isStageBlockedForState(claim.property_state, stage)");
  const stamp = src.indexOf("const metaKey = `stage${stage}_sent_at`");
  assert(gate > 0, "gate call missing");
  assert(stamp > 0 && gate < stamp, "gate must come before the stage stamp");
});
