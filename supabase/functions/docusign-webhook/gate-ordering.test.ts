// gh-1467 — the gate-1 ORDERING regression test.
//
// live-charge-guard.test.ts proves the guard's LOGIC. It cannot prove the
// guard is ever REACHED, and on 2026-09-07 it was measured that it never was:
// docusign-webhook/index.ts evaluated the card-on-file check 34 lines BEFORE
// the guard, so every card-less contractor threw
// `does not have payment method on file` and the guard was skipped. Gate 1 had
// therefore never been observed refusing anything in production — not because
// it was broken, but because it was unreachable. Exactly one of thirteen
// contractors has a card on file, and that one's profile row asserts
// is_test = false, so no test ceremony could reach the guard at all.
//
// This test asserts that the property which made it unreachable is gone: in
// the post-signature charge path, the guard call site must PRECEDE the
// no-method throw. It is a source-order assertion because the defect was a
// source-order defect — no amount of unit-testing the pure module catches it.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const GUARD_CALL = "const chargeGuard = evaluateLiveChargeGuard(claim);";
const NO_METHOD_THROW = "does not have payment method on file";

Deno.test("gh-1467: the live-charge guard is evaluated BEFORE the card-on-file check", () => {
  const guardAt = source.indexOf(GUARD_CALL);
  const noMethodAt = source.indexOf(NO_METHOD_THROW);

  assert(guardAt !== -1, `guard call site not found: ${GUARD_CALL}`);
  assert(noMethodAt !== -1, `no-method throw not found: ${NO_METHOD_THROW}`);

  assert(
    guardAt < noMethodAt,
    "REGRESSION (gh-1467): the card-on-file check runs before the live-charge " +
      "guard. Every card-less contractor throws before the guard is evaluated, " +
      "which makes gate 1 unreachable — the exact condition that kept #1467 " +
      "open. Move the no-method check back below the guard block.",
  );
});

Deno.test("gh-1467: there is exactly one guard call site in the charge path", () => {
  // Two call sites would let one of them be reordered without the assertion
  // above noticing, which is how this defect would come back.
  assertEquals(source.split(GUARD_CALL).length - 1, 1);
});

Deno.test("gh-1467: the guard still refuses by returning, not by throwing", () => {
  // The catch below the charge path buckets EVERY pre-charge throw as
  // `signed_unbilled_no_method`. If the guard ever threw, its refusal would be
  // swallowed and misreported as a missing card — indistinguishable from the
  // failure mode this reordering exists to escape.
  const guardAt = source.indexOf(GUARD_CALL);
  const block = source.slice(guardAt, guardAt + 4000);
  const branchAt = block.indexOf("if (!chargeGuard.allow)");
  assert(branchAt !== -1, "the guard verdict is no longer tested as an explicit branch");
  const returnAt = block.indexOf("return new Response(", branchAt);
  const throwAt = block.indexOf("throw new Error(", branchAt);
  assert(returnAt !== -1, "the refusal branch no longer returns a Response");
  assert(
    throwAt === -1 || returnAt < throwAt,
    "the refusal branch throws before it returns — the catch would swallow it",
  );
});
