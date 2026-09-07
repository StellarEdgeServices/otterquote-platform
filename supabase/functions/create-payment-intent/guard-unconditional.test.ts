// gh-1760 — the is_test guard must be UNCONDITIONAL, not scoped by metadata.type.
//
// live-charge-guard.test.ts proves the guard's LOGIC (9/9 passing, and this file
// does not duplicate that). What it cannot prove is that the guard is APPLIED to
// every charge type. On origin/main it is applied inside the metadata.type
// switch and only two of four branches carry it:
//
//   platform_fee        index.ts:181 -> guarded
//   measurement_upgrade index.ts:265 -> guarded
//   hover_measurement   index.ts:341 -> ownership check ONLY
//   deductible_escrow   index.ts:341 -> ownership check ONLY
//
// The live-vs-test Stripe key is chosen from the request Origin, so a real
// browser on a production origin gets the LIVE key on those two paths whatever
// claims.is_test says. Measured 2026-09-07: 11 is_test claims with no
// live_charge_authorized_at x $15.00 = $165.00, plus one carrying
// deductible_amount 1000.00 -> a $1,165.00 ceiling. Nothing charged through it.
//
// This is a STRUCTURAL test because the defect is structural: the guard's logic
// is fine and every unit test of it passes on the broken code. What has to be
// asserted is the guard's brace DEPTH — that at least one guard evaluation sits
// outside every metadata.type branch, at the same depth as the rate-limit call,
// which is unconditional in the request path on both main and this branch.
//
// NEGATIVE CONTROL: test 1 and test 2 FAIL against origin/main's index.ts and
// pass here. See the PR body for both runs side by side.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateLiveChargeGuard } from "./live-charge-guard.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/**
 * Brace depth at every character offset, with line comments, block comments,
 * string literals and template literals stripped first so that a `{` inside a
 * comment or a `${...}` inside a string cannot move the depth. Deliberately a
 * small scanner rather than a regex: an indentation proxy would be gameable by
 * reformatting, and depth is the property that actually means "unconditional".
 */
function depthMap(text: string): Int32Array {
  const depth = new Int32Array(text.length);
  let d = 0;
  let i = 0;
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") mode = "line";
      else if (c === "/" && n === "*") mode = "block";
      else if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      else if (c === "{") d++;
      else if (c === "}") d--;
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
    } else if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; depth[i] = d; i++; depth[i] = d; i++; continue; }
    } else if (mode === "sq" || mode === "dq" || mode === "tpl") {
      if (c === "\\") { depth[i] = d; i++; if (i < text.length) depth[i] = d; i++; continue; }
      if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
        mode = "code";
      }
    }
    depth[i] = d;
    i++;
  }
  return depth;
}

function allOffsets(text: string, needle: string): number[] {
  const out: number[] = [];
  let at = text.indexOf(needle);
  while (at !== -1) { out.push(at); at = text.indexOf(needle, at + 1); }
  return out;
}

const depth = depthMap(source);

const RATE_LIMIT_CALL = 'supabase.rpc("check_rate_limit"';
const GUARD_CALL = "evaluateLiveChargeGuard(";
const STRIPE_PI_POST = "${STRIPE_API_BASE}/payment_intents`";

const rateLimitAt = source.indexOf(RATE_LIMIT_CALL);
assert(rateLimitAt !== -1, `rate-limit call site not found: ${RATE_LIMIT_CALL}`);
const REQUEST_PATH_DEPTH = depth[rateLimitAt];

const guardSites = allOffsets(source, GUARD_CALL);
const unconditionalSites = guardSites.filter((at) => depth[at] === REQUEST_PATH_DEPTH);

Deno.test("gh-1760: at least one is_test guard is evaluated OUTSIDE every metadata.type branch", () => {
  assert(guardSites.length > 0, "no live-charge guard evaluation exists at all");
  assert(
    unconditionalSites.length > 0,
    "REGRESSION (gh-1760): every evaluateLiveChargeGuard() call site sits at a " +
      `brace depth deeper than the unconditional request path (expected depth ${REQUEST_PATH_DEPTH}, ` +
      `found depths [${guardSites.map((at) => depth[at]).join(", ")}]). That means the is_test ` +
      "guard is scoped by metadata.type, so hover_measurement and deductible_escrow reach a LIVE " +
      "Stripe key on an is_test claim with an ownership check only — the exact condition #1760 " +
      "was filed against. Add one guard evaluation outside the metadata.type switch.",
  );
});

Deno.test("gh-1760: no PaymentIntent is created before the unconditional guard runs", () => {
  const posts = allOffsets(source, STRIPE_PI_POST);
  assert(posts.length > 0, "no Stripe /payment_intents call site found — has this file moved?");
  assert(
    unconditionalSites.length > 0,
    "REGRESSION (gh-1760): there is no unconditional guard evaluation at all, so EVERY " +
      `Stripe /payment_intents call (${posts.length} of them) can run without the claim's ` +
      "test status having been read on the hover_measurement / deductible_escrow path.",
  );
  const firstUnconditional = Math.min(...unconditionalSites);
  for (const at of posts) {
    assert(
      at > firstUnconditional,
      `a Stripe /payment_intents call at offset ${at} precedes the unconditional guard at ` +
        `offset ${firstUnconditional}: money can move before the claim's test status is read.`,
    );
  }
});

Deno.test("gh-1760: the guard refuses an is_test deductible_escrow claim with no human authorization", () => {
  // The $1,000.00 row measured on 2026-09-07: is_test true, marker absent.
  const verdict = evaluateLiveChargeGuard({
    id: "f3bfb1f9-0000-0000-0000-000000000000",
    is_test: true,
    live_charge_authorized_at: null,
  });
  assertEquals(verdict.allow, false);
  assertEquals(verdict.reason, "test_claim_unauthorized");
});

Deno.test("gh-1760: making the guard unconditional does NOT break a deliberate authorized live test", () => {
  // Dustin's ruling on #1467 ("That charge was a test and expected." / "Keep
  // it") is the reason a blanket is_test refusal would be worse than the
  // defect. An authorized test row must still be chargeable on every type.
  const verdict = evaluateLiveChargeGuard({
    id: "73208937-a1c2-4db5-b402-3e7ec76374ae",
    is_test: true,
    live_charge_authorized_at: "2026-09-05T19:26:43.183053+00:00",
  });
  assertEquals(verdict.allow, true);
  assertEquals(verdict.reason, "authorized");
});

Deno.test("gh-1760: a real homeowner's claim is unaffected on every charge type", () => {
  const verdict = evaluateLiveChargeGuard({
    id: "82f5dff4-5867-4b7a-88ca-942ce9bfe867",
    is_test: false,
    live_charge_authorized_at: null,
  });
  assertEquals(verdict.allow, true);
  assertEquals(verdict.reason, "not_test");
});
