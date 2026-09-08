// gh-1759 — the STRUCTURAL half, and the half that fails against origin/main.
//
// dispute-routing.test.ts specifies the behaviour of the two new gates. It
// cannot prove that claims.platform_fee_stripe_id now HAS a writer, and "no
// writer exists" was the whole finding: on main the column is read at
// stripe-webhook/index.ts:420 and :422 and written nowhere in the repository.
// `git log --all -S "platform_fee_stripe_id"` returns exactly one commit ever —
// the commit that added the two READ sites — and a pg_proc scan on production
// returns [] (no trigger, no RPC). Measured 2026-09-07: 0 non-null across all
// 16 claims, with 1 claim marked platform_fee_charged = true.
//
// So this file asserts the WRITE SITES exist and that the auto-concession is
// gone, by reading the three functions' sources. Four of its assertions FAIL
// against origin/main. See the PR body for both runs.
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const dir = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, dir));

const createPaymentIntent = await read("create-payment-intent/index.ts");
const docusignWebhook = await read("docusign-webhook/index.ts");
const stripeWebhook = await read("stripe-webhook/index.ts");

Deno.test("gh-1759: create-payment-intent RETURNS the Stripe charge id to its callers", () => {
  // The root cause. No caller could ever have persisted the charge id because
  // this function never handed one to anybody.
  assert(
    /charge_id:\s*latestCharge/.test(createPaymentIntent),
    "REGRESSION (gh-1759): create-payment-intent's response does not carry `charge_id`. " +
      "Nothing downstream can write claims.platform_fee_stripe_id, so the dispute lookup at " +
      "stripe-webhook/index.ts:422 remains structurally dead no matter what the callers do.",
  );
  assert(
    /latest_charge/.test(createPaymentIntent),
    "REGRESSION (gh-1759): create-payment-intent never reads Stripe's `latest_charge`.",
  );
});

Deno.test("gh-1759: docusign-webhook WRITES claims.platform_fee_stripe_id on the card success path", () => {
  assert(
    /updateData\.platform_fee_stripe_id\s*=/.test(docusignWebhook),
    "REGRESSION (gh-1759): docusign-webhook flips platform_fee_charged on a confirmed card " +
      "charge but never records platform_fee_stripe_id, so the claim cannot be found from a " +
      "disputed charge. This is the synchronous half of the writer.",
  );
  assert(
    /updateData\.platform_fee_amount\s*=/.test(docusignWebhook),
    "REGRESSION (gh-1759): platform_fee_amount is still never written; the dispute evidence " +
      "packet has no fee amount to state.",
  );
});

Deno.test("gh-1759: stripe-webhook WRITES claims.platform_fee_stripe_id on the ACH settle path", () => {
  // An ACH charge has no charge id at creation time, so the synchronous writer
  // above cannot cover it. Without this half, ACH-paid fees stay unresolvable.
  assert(
    /platform_fee_stripe_id:\s*latestChargeId/.test(stripeWebhook),
    "REGRESSION (gh-1759): stripe-webhook's payment_intent.succeeded handler flips " +
      "platform_fee_charged but does not record the charge id, so every ACH-paid platform fee " +
      "keeps an empty column and its dispute stays unresolvable.",
  );
});

Deno.test("gh-1759: evidence[submit] is NO LONGER set unconditionally", () => {
  // THE AUTO-CONCESSION. On main the evidence object literal contains
  //     "evidence[submit]": "true",
  // inline, so a null-claim payload was submitted FINAL, carrying the sentence
  // "FEE ACCEPTANCE RECORD: Not found in database".
  const unconditional = /const evidence: Record<string, string> = \{[^}]*"evidence\[submit\]":\s*"true"/s;
  assert(
    !unconditional.test(stripeWebhook),
    'REGRESSION (gh-1759): `"evidence[submit]": "true"` is set inside the evidence object ' +
      "literal, i.e. unconditionally. Stripe accepts ONE final submission per dispute; on a " +
      "claim lookup miss this spends it on a payload that states our own fee-acceptance record " +
      'was "Not found in database". That is an automatic, irreversible concession.',
  );
  assert(
    /maySubmitFinalEvidence\(\{/.test(stripeWebhook),
    "REGRESSION (gh-1759): the evidence builder does not consult maySubmitFinalEvidence(), so " +
      "nothing stops a blind final submission.",
  );
});

Deno.test("gh-1759: dispute routing considers whether the claim was resolved at all", () => {
  assert(
    /claimResolved:\s*!isClaimUnresolved/.test(stripeWebhook),
    "REGRESSION (gh-1759): routeToManualQueue is computed from amount and reason only. A " +
      "sub-$500 dispute that resolves to no claim therefore falls into the auto-submit branch " +
      "— the exact path that concedes the chargeback.",
  );
  assert(
    /alert_type:\s*"dispute_claim_unresolved"/.test(stripeWebhook),
    "REGRESSION (gh-1759): an unresolvable dispute produces no alert, so the failure is silent.",
  );
});
