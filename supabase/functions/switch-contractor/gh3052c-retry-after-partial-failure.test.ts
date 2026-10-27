// gh-3052 review B1 -- retry after a step 7 failure must still refund exactly once and report truthfully.
// Scenario: step 6 retired the quote (declined/superseded), step 7 (claim reset) returned 500, the claim is
// still contract_signed with selected_contractor_id set. The homeowner retries.
// FAIL-FIRST: on c5e89510 (step 5 only matched selected/awarded; no winning-quote.ts) every test here fails.
// Run: deno test --allow-read=supabase/functions supabase/functions/switch-contractor/gh3052c-retry-after-partial-failure.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isRetiredBySwitch, pickWinningQuote, shouldIssueRefund, WINNING_QUOTE_OR_FILTER,
} from "./winning-quote.ts";

const sw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const live = { id: "q1", status: "selected", bid_status: "active", cancellation_reason: null,
  payment_intent_id: "pi_1", payment_status: "succeeded" };
// what step 6 leaves behind when step 7 then fails
const retiredAfterStep6 = { ...live, status: "declined", bid_status: "superseded",
  cancellation_reason: "homeowner_switched_contractor" };

// Tiny in-memory model of the quotes table + the step-5 filter, to simulate call 1 (step 7 fails) then call 2.
function matchesStep5(q: Record<string, unknown>): boolean {
  return ["selected", "awarded"].includes(q.status as string) || isRetiredBySwitch(q);
}

Deno.test("retry after step 7 failure: step 5 finds the retired quote and the refund gate opens", () => {
  const table = [{ ...retiredAfterStep6 }]; // state after call 1
  const found = pickWinningQuote(table.filter(matchesStep5));
  assert(found, "retry must find the quote this flow already retired");
  assertEquals(found!.id, "q1");
  assert(shouldIssueRefund(found as any, true), "owed Stripe refund must be issued on the retry");
});

Deno.test("refund at most once: after a successful refund the gate is closed", () => {
  assert(shouldIssueRefund(live, true));
  assert(!shouldIssueRefund({ ...retiredAfterStep6, payment_status: "refunded" }, true));
  assert(!shouldIssueRefund(live, false), "no Stripe key -> no refund attempt");
  assert(!shouldIssueRefund(null, true));
});

Deno.test("a live selected quote beats an older retired one; foreign retired shapes are not admitted", () => {
  const older = { ...retiredAfterStep6, id: "old" };
  assertEquals(pickWinningQuote([older, { ...live, id: "new" }])!.id, "new");
  assert(!matchesStep5({ ...retiredAfterStep6, cancellation_reason: "expired" }));
  assert(!matchesStep5({ ...retiredAfterStep6, bid_status: "active" }));
  assert(!matchesStep5({ ...retiredAfterStep6, status: "submitted" }));
  assertEquals(pickWinningQuote([]), null);
});

Deno.test("index.ts wires it: step 5 uses the retry-safe filter, step 8 uses the gate, still scoped to the claim and contractor", () => {
  const a = sw.indexOf("// ── 5. Load the winning quote");
  const b = sw.indexOf("// ── 6. Cancel the quote");
  assert(a !== -1 && b > a);
  const step5 = sw.slice(a, b);
  assertStringIncludes(step5, ".or(WINNING_QUOTE_OR_FILTER)");
  assertStringIncludes(step5, '.eq("claim_id", claim_id)');
  assertStringIncludes(step5, '.eq("contractor_id", claim.selected_contractor_id)');
  assert(!step5.includes('.in("status", ["selected", "awarded"])'), "old selected/awarded-only filter must be gone");
  assertStringIncludes(step5, "pickWinningQuote(");
  assertStringIncludes(sw, "if (shouldIssueRefund(winningQuote, !!stripeKey))");
  assertStringIncludes(WINNING_QUOTE_OR_FILTER, "status.in.(selected,awarded)");
  assertStringIncludes(WINNING_QUOTE_OR_FILTER, "cancellation_reason.eq.homeowner_switched_contractor");
});

Deno.test("response never claims refund_issued unless a Stripe refund id exists", () => {
  assertStringIncludes(sw, "refund_issued: refundResult.success && !!refundResult.refundId,");
});
