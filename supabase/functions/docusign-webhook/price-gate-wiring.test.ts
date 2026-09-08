/**
 * [#1314 FIX / F3, 2026-09-08] SOURCE-ORDER + WIRING TEST for the signed-price
 * gate in index.ts.
 *
 * WHY A STRUCTURAL TEST. LEGAL-READ (R-177) failed PR #1798 on three grounds,
 * two of which no unit test of `price-verify.ts` could ever have caught:
 *
 *   F1 — the halt was SKIPPED whenever the BoldSign document/properties read
 *        failed, because the price block was gated on a nullable
 *        `if (signerStatus)` assigned inside a catch commented "fail-open".
 *   F3 — `dispositionFor` was computed and then consulted only inside one
 *        console.log, while the production if-chain hardcoded its own
 *        conditions. So the PR's mutation negative control ("dispositionFor ->
 *        always flag") reddened three unit tests while changing ZERO deployed
 *        behaviour.
 *
 * Both are properties of the CALL SITE, not of the pure module. This file
 * asserts them against the source text of index.ts, the same instrument
 * gh-1467 used for gate reachability. A green unit suite plus a green wiring
 * suite is the pair that makes the mutation control real: mutate
 * `dispositionFor` and the deployed chain below changes behaviour, because the
 * chain branches on it.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/**
 * `src` with whole-line comments removed. The absence assertions below run
 * against this, not against `src`, because the fix's own comments QUOTE the
 * pre-fix code they replaced (`if (signerStatus)`) and a raw substring search
 * would match the explanation instead of the defect. Trailing comments on code
 * lines are left in place — they cannot hide a call-site gate.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*");
  })
  .join("\n");

Deno.test("gh-1314 F1: the properties read is resolved into an explicit result", () => {
  assertStringIncludes(src, "await resolveSignerStatus(() => fetchDocumentSignerStatus(envelopeId))");
});

Deno.test("gh-1314 F1: the price block is NOT gated on a nullable signerStatus", () => {
  // The pre-fix gate. Its presence means a failed properties read silently
  // skips the whole reconciliation and the fee is charged on an unread price.
  assertEquals(
    code.includes("if (signerStatus)"),
    false,
    "REGRESSION (gh-1314 F1): the price block is gated on `if (signerStatus)` again. " +
      "A failed BoldSign document/properties read leaves that null, so the halt is skipped " +
      "and the platform fee is charged on a contract whose price was never read. " +
      "Branch on the result of resolveSignerStatus() instead.",
  );
});

Deno.test("gh-1314 F1: a failed properties read reaches the halt via priceVerdictFor", () => {
  assertStringIncludes(src, "priceVerdictFor(signerStatusResult, expected)");
});

Deno.test("gh-1314 F1: the price catch HALTS instead of proceeding to charge", () => {
  const catchAt = src.indexOf("} catch (priceErr) {");
  assertEquals(catchAt > -1, true, "the price reconciliation catch block is gone");
  const tail = src.slice(catchAt, catchAt + 4000);
  assertStringIncludes(tail, 'defect: "contract_price_unverified"');
  assertStringIncludes(tail, 'alert_type: "signed_price_unverified"');
  assertStringIncludes(tail, "reportToSentry(priceErr");
  assertEquals(
    code.includes("price reconciliation errored (proceeding, alerted)"),
    false,
    "REGRESSION (gh-1314 F1): the price reconciliation catch proceeds to charge again. " +
      "An exception here means no verdict was reached, so the price is unverified, so it halts.",
  );
});

Deno.test("gh-1314 F3: the production chain branches on dispositionFor, not hardcoded states", () => {
  assertStringIncludes(src, "const disposition = dispositionFor(verdict);");
  const branches = code.match(/disposition === "(flag|halt|proceed)"/g) ?? [];
  assertEquals(
    branches.length >= 4,
    true,
    "REGRESSION (gh-1314 F3): the deployed if-chain no longer branches on `disposition`, so " +
      "mutating dispositionFor() reddens unit tests without changing deployed behaviour — the " +
      `negative control stops discriminating the money path. Found ${branches.length} branches.`,
  );
  // Every disposition value must be reachable from the chain.
  for (const want of ['disposition === "flag"', 'disposition === "halt"', 'disposition === "proceed"']) {
    assertStringIncludes(code, want);
  }
});

Deno.test("gh-1314 F3: an unclassified disposition is fail-closed, never a silent proceed", () => {
  assertStringIncludes(src, "#1314 unclassified price disposition=");
  assertStringIncludes(src, "refusing to charge");
});

Deno.test("gh-1314: the price gate precedes every path to money", () => {
  const gate = src.indexOf("[#1314] SIGNED-PRICE RECONCILIATION");
  const charge = src.indexOf("HANDLE PAYMENT CHARGING (D-127)");
  const stripe = src.indexOf("create-payment-intent");
  assertEquals(gate > -1 && charge > -1 && stripe > -1, true, "expected markers missing");
  assertEquals(
    gate < charge && gate < stripe,
    true,
    "REGRESSION (gh-1314): the signed-price gate no longer precedes the D-127 charge block. " +
      "A mismatch must block the invoice, not be discovered after money moves.",
  );
});

/* [#1314 step 4, 2026-09-08] The verdict must be RECORDED, and recorded before
 * the branches that return early. */

Deno.test("gh-1314 step 4: the verdict is persisted BEFORE the disposition branches", () => {
  const verdictAt = code.indexOf("const verdict = priceVerdictFor(signerStatusResult, expected);");
  const persistAt = code.indexOf("await persistSignedPriceVerdict(supabase, claim.id, signerStatusResult, verdict)");
  const dispositionAt = code.indexOf("const disposition = dispositionFor(verdict);");
  assertEquals(verdictAt > -1 && persistAt > -1 && dispositionAt > -1, true, "expected call sites missing");
  assertEquals(
    verdictAt < persistAt && persistAt < dispositionAt,
    true,
    "REGRESSION (gh-1314 step 4): the persistence write no longer sits between the verdict and the " +
      "disposition chain. The halt branches return early, so a write inside them records every " +
      "verdict EXCEPT the halting ones — which are the ones this issue exists to make queryable.",
  );
});

Deno.test("gh-1314 step 4: the fail-closed catch records its verdict too", () => {
  const catchAt = code.indexOf("} catch (priceErr) {");
  const tail = code.slice(catchAt, catchAt + 2500);
  assertStringIncludes(tail, "await persistSignedPriceVerdict(supabase, claim.id, null, verdict)");
});

Deno.test("gh-1314 step 4: a REJECTED persistence write is logged, not swallowed", () => {
  // PostgREST reports a rejected write in `error` on a RESOLVED promise; it does
  // not throw. A bare try/catch would swallow a missing column or a violated
  // CHECK in silence — the #1538 failure mode.
  assertStringIncludes(src, "signed-price persistence REJECTED");
  assertEquals(
    /const \{ error \} = await supabase\s*\n?\s*\.from\("claims"\)/.test(src),
    true,
    "REGRESSION (gh-1314 step 4): the persistence write no longer inspects PostgREST's `error`, " +
      "so a rejected write is silent.",
  );
});
