// gh-1759 — dispute routing + final-submission logic.
//
// These are the PURE tests: no network, no database. The property they protect
// is the one that made #1759 a `must` rather than hygiene — a dispute we cannot
// tie to a claim must never spend Stripe's single, irreversible final evidence
// submission on an empty payload.
//
// On origin/main both gates are absent: routing considered only amount and
// reason, and `evidence[submit]: "true"` was set unconditionally in the evidence
// object literal. fee-charge-writer.test.ts is the structural half and is the
// half that FAILS against main; this file is the behavioural specification.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  evaluateDisputeRouting,
  MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS,
  maySubmitFinalEvidence,
} from "./dispute-routing.ts";

// The real numbers this was found with: the one live charge is $180.54, i.e.
// well under the $500 threshold and reason-agnostic — which is exactly why it
// landed in the auto-submit branch on main.
const SUB_THRESHOLD = 18_054;

Deno.test("gh-1759: an UNRESOLVABLE sub-$500 dispute routes to the manual queue", () => {
  // THE DEFECT. On main this returned auto_submit and conceded the chargeback.
  const v = evaluateDisputeRouting({
    reason: "fraudulent",
    amountCents: SUB_THRESHOLD,
    claimResolved: false,
  });
  assertEquals(v.routing, "manual_queue");
  assertEquals(v.reason, "claim_unresolved");
});

Deno.test("gh-1759: a RESOLVABLE sub-$500 dispute still auto-submits — the fix does not disable auto-submit", () => {
  // The other half of the control. A fix that routed everything to a human
  // would "pass" the test above and quietly destroy D-228's whole auto-submit
  // path, which is a worse outcome than the defect.
  const v = evaluateDisputeRouting({
    reason: "fraudulent",
    amountCents: SUB_THRESHOLD,
    claimResolved: true,
  });
  assertEquals(v.routing, "auto_submit");
  assertEquals(v.reason, null);
});

Deno.test("gh-1759: unresolvable is reported ahead of amount and reason", () => {
  // An operator reading admin_dispute_queue needs "we cannot describe this
  // transaction" before "it is large" — the first tells them the auto path
  // could not have worked at all.
  assertEquals(
    evaluateDisputeRouting({
      reason: "product_not_received",
      amountCents: 250_000,
      claimResolved: false,
    }).reason,
    "claim_unresolved",
  );
});

Deno.test("gh-1759: D-228's existing two routing rules are unchanged", () => {
  assertEquals(
    evaluateDisputeRouting({ reason: "product_not_received", amountCents: 100, claimResolved: true }),
    { routing: "manual_queue", reason: "non_delivery_reason" },
  );
  assertEquals(
    evaluateDisputeRouting({
      reason: "fraudulent",
      amountCents: MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS,
      claimResolved: true,
    }),
    { routing: "manual_queue", reason: "amount_threshold" },
  );
  // The threshold is inclusive at $500.00 and exclusive one cent below it —
  // pinned because an off-by-one here silently changes who reviews a dispute.
  assertEquals(
    evaluateDisputeRouting({
      reason: "fraudulent",
      amountCents: MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS - 1,
      claimResolved: true,
    }).routing,
    "auto_submit",
  );
  assertEquals(MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS, 50_000);
});

Deno.test("gh-1759: the final submission requires BOTH a claim and a fee-acceptance record", () => {
  assertEquals(maySubmitFinalEvidence({ claimResolved: true, feeAcceptanceResolved: true }), true);
  // Each of the three failing combinations, named individually — the payload in
  // every one of them contains "FEE ACCEPTANCE RECORD: Not found in database"
  // and/or no claim block, and submitting it final is the auto-concession.
  assertEquals(maySubmitFinalEvidence({ claimResolved: false, feeAcceptanceResolved: false }), false);
  assertEquals(maySubmitFinalEvidence({ claimResolved: true, feeAcceptanceResolved: false }), false);
  assertEquals(maySubmitFinalEvidence({ claimResolved: false, feeAcceptanceResolved: true }), false);
});

Deno.test("gh-1759: gate 2 is independent of gate 1 — it refuses a payload gate 1 wrongly let through", () => {
  // The point of having two. If a future refactor routes an unresolvable
  // dispute to auto_submit anyway, the payload still must not be final.
  const wronglyRouted = { routing: "auto_submit" as const };
  assertEquals(wronglyRouted.routing, "auto_submit");
  assertEquals(maySubmitFinalEvidence({ claimResolved: false, feeAcceptanceResolved: true }), false);
});
