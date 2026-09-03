import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AUTHORIZATION_COLUMN,
  describeGuardVerdict,
  evaluateLiveChargeGuard,
  REFUSAL_CODE,
} from "./live-charge-guard.ts";

Deno.test("a real claim is charged exactly as before", () => {
  assertEquals(evaluateLiveChargeGuard({ id: "c1", is_test: false }), {
    allow: true,
    reason: "not_test",
  });
  assertEquals(
    evaluateLiveChargeGuard({ id: "c1", is_test: false, live_charge_authorized_at: null }),
    { allow: true, reason: "not_test" },
  );
});

Deno.test("the 2026-08-31 case: a TEST claim with no marker is REFUSED", () => {
  // claims.82f5dff4-5867-4b7a-88ca-942ce9bfe867 as it stood when it charged
  // a real card $180.54 five seconds after the ceremony completed.
  assertEquals(
    evaluateLiveChargeGuard({
      id: "82f5dff4-5867-4b7a-88ca-942ce9bfe867",
      is_test: true,
      live_charge_authorized_at: null,
    }),
    { allow: false, reason: "test_claim_unauthorized" },
  );
});

Deno.test("a TEST claim WITH the marker is permitted — Dustin's fee-path verification survives", () => {
  // The whole point of the revision. A blanket is_test refusal would have made
  // #524's durable test contractor useless and the fee path unprovable.
  assertEquals(
    evaluateLiveChargeGuard({
      id: "c2",
      is_test: true,
      live_charge_authorized_at: "2026-08-31T22:32:56+00:00",
    }),
    { allow: true, reason: "authorized", authorizedAt: "2026-08-31T22:32:56+00:00" },
  );
});

Deno.test("an empty-string marker does not authorise anything", () => {
  assertEquals(
    evaluateLiveChargeGuard({ id: "c3", is_test: true, live_charge_authorized_at: "   " }),
    { allow: false, reason: "test_claim_unauthorized" },
  );
  assertEquals(
    evaluateLiveChargeGuard({ id: "c3", is_test: true, live_charge_authorized_at: "" }),
    { allow: false, reason: "test_claim_unauthorized" },
  );
});

Deno.test("FAIL CLOSED: an unreadable claim refuses rather than charging", () => {
  // is_test is NOT NULL in the live schema, so null/undefined here means
  // "no row was read", not "false". A missing row must not read as a real claim.
  assertEquals(evaluateLiveChargeGuard(null), { allow: false, reason: "claim_unreadable" });
  assertEquals(evaluateLiveChargeGuard(undefined), { allow: false, reason: "claim_unreadable" });
  assertEquals(evaluateLiveChargeGuard({ id: "c4" }), {
    allow: false,
    reason: "claim_unreadable",
  });
  assertEquals(evaluateLiveChargeGuard({ id: "c4", is_test: null }), {
    allow: false,
    reason: "claim_unreadable",
  });
});

Deno.test("a truthy-but-not-true is_test is treated as a real claim, not a test one", () => {
  // Defensive: the guard compares against `true`, so a string "true" coming
  // from a loosely-typed source does NOT silently become a test row. Stated as
  // a test so the behaviour is a decision rather than an accident.
  assertEquals(
    evaluateLiveChargeGuard({ id: "c5", is_test: "true" as unknown as boolean }),
    { allow: true, reason: "not_test" },
  );
});

Deno.test("every refusal message names the amount that was not taken", () => {
  const refused = evaluateLiveChargeGuard({ id: "c6", is_test: true });
  const msg = describeGuardVerdict(refused, "c6", 18054);
  assertEquals(msg.includes("REFUSED"), true);
  assertEquals(msg.includes("18054 cents"), true);
  assertEquals(msg.includes(AUTHORIZATION_COLUMN), true);

  const unknownAmount = describeGuardVerdict(refused, "c6", null);
  assertEquals(unknownAmount.includes("an undetermined amount"), true);
});

Deno.test("the permitted-on-test message says WHY it was permitted", () => {
  const allowed = evaluateLiveChargeGuard({
    id: "c7",
    is_test: true,
    live_charge_authorized_at: "2026-09-02T03:00:00+00:00",
  });
  const msg = describeGuardVerdict(allowed, "c7", 18054);
  assertEquals(msg.includes("TEST row"), true);
  assertEquals(msg.includes("2026-09-02T03:00:00+00:00"), true);
});

Deno.test("the refusal code is stable and distinct", () => {
  assertEquals(REFUSAL_CODE, "TEST_CLAIM_CHARGE_REFUSED");
});
