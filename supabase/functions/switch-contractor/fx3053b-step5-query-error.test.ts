// fx3053b -- review finding on PR #3053: step 5 (winning-quote lookup) must not ignore a query error.
// If the lookup fails and the code proceeds as "no quote found", the quote is never retired and the owed
// Stripe refund is silently skipped. Required: log for ops, return 500, no refund/retire attempted.
// index.ts calls serve() and cannot be imported, so (repo pattern) this asserts the wiring from source text.
// FAIL-FIRST: on c3a89cdd step 5 destructures only `{ data: quotes }`; every assertion below fails there.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const a = src.indexOf("// ── 5. Load the winning quote");
const b = src.indexOf("// ── 6. Cancel the quote");
assert(a !== -1 && b > a, "step 5/6 anchors moved; update this test");
const step5 = src.slice(a, b);

Deno.test("step 5 captures the query error", () => {
  assertStringIncludes(step5, "error: winningQuoteError");
});

Deno.test("step 5 query error logs for ops and returns 500 BEFORE pickWinningQuote (never 'no quote found')", () => {
  const errIdx = step5.indexOf("if (winningQuoteError)");
  const pickIdx = step5.indexOf("pickWinningQuote(");
  assert(errIdx !== -1, "missing if (winningQuoteError) guard");
  assert(pickIdx > errIdx, "guard must precede pickWinningQuote");
  const guard = step5.slice(errIdx, pickIdx);
  assertStringIncludes(guard, "console.error(");
  assertStringIncludes(guard, "return jsonResponse(");
  assertStringIncludes(guard, ", 500)");
});

Deno.test("the abort happens before any quote retire (step 6) or refund (step 8) code", () => {
  const stripeCall = src.indexOf("stripeRefund(stripeKey");
  const retire = src.indexOf("// ── 6. Cancel the quote");
  const guardAt = src.indexOf("if (winningQuoteError)");
  assert(guardAt !== -1 && guardAt < retire && retire < stripeCall);
});
