// gh-1886 B1/B2 (independent review on #2198, 2026-09-25).
//
// B1: a timeout on a CONFIRMED off-session create does not mean Stripe did not charge the card/bank
// account -- it only means this function stopped waiting. The pre-fix loop treated that exactly like a
// genuine decline and moved on to a DIFFERENT payment method, which can double-charge (the two methods'
// Idempotency-Keys never collide). The fix: retry the SAME method once under the SAME key (a documented
// Stripe idempotent replay), and if THAT also times out, stop the whole loop rather than try another
// method.
//
// B2: this file drives the REAL runOffSessionPlatformFeeCharge (extracted from index.ts) against a fake
// Stripe, so the double-charge reproduction is a real behavioural test, not a source-text assertion. It
// also pins index.ts and off-session-charge.ts structurally, mirroring standard-create-form.test.ts's
// "index.ts uses them, and only them" pattern in this same folder.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AmbiguousChargeOutcomeError, runOffSessionPlatformFeeCharge } from "./off-session-charge.ts";
import { fetchStripeWithTimeout } from "./stripe-fetch.ts";

const API = "https://api.stripe.com/v1";
const CLAIM = "claim1";
const CONTRACTOR = "ctr1";

interface Call { url: string; key: string | null; method: string }

/**
 * A fake Stripe where the FIRST create attempt for any given Idempotency-Key hangs (rejects only when
 * aborted) but ALSO marks the charge "committed" the instant that first attempt is made -- simulating a
 * real off-session confirmed charge that Stripe processes even though our client never sees the answer. A
 * SECOND attempt with the SAME key is Stripe's documented idempotent replay: it returns the same
 * PaymentIntent, with no new commit. A create for a NEW key (a different payment method) commits its own,
 * separate charge -- which is exactly the double charge this fix prevents.
 */
function fakeAmbiguousStripe() {
  const calls: Call[] = [];
  const committed: string[] = [];
  const attempts = new Map<string, number>();
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push({ url, key, method: String(init?.method) });
    if (url.endsWith("/payment_intents") && init?.method === "POST") {
      const n = (attempts.get(key!) ?? 0) + 1;
      attempts.set(key!, n);
      if (n === 1) {
        committed.push(key!); // Stripe charges it now, regardless of whether our client ever finds out.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ id: `pi_${key}`, status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 })); // cancel or anything else
  }) as unknown as typeof fetch;
  return { fetchFn, calls, committed };
}

const twoMethods = [
  { stripe_payment_method_id: "pm_A", payment_type: "card", id: "m1" },
  { stripe_payment_method_id: "pm_B", payment_type: "us_bank_account", id: "m2" },
];

// -- B2(b): the reviewer's double-charge reproduction, and its fix -----------------------------------

Deno.test("gh-1886 B1 fix: a timeout on method A's create NEVER produces a create for method B; the same-key retry recovers method A's own charge", async () => {
  const { fetchFn, calls, committed } = fakeAmbiguousStripe();
  const result = await runOffSessionPlatformFeeCharge({
    fetchFn,
    apiBase: API,
    basicAuth: "QUJD",
    claimId: CLAIM,
    contractorId: CONTRACTOR,
    stripeCustomerId: "cus_1",
    currency: "usd",
    description: "Platform fee",
    amount: 1000,
    methodsToTry: twoMethods,
    calculateCardChargeAmount: (c) => c, // no surcharge, to keep the key/amount math simple in this test
    timeoutMs: 30,
  });
  assertEquals(result.usedMethod.stripe_payment_method_id, "pm_A");
  assertEquals(result.paymentIntentData.id, "pi_plat-fee-claim1-ctr1-pm_A");
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A"], "Stripe committed exactly ONE charge, for method A");
  assert(
    !calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"),
    "method B's Idempotency-Key was never sent -- no create attempt was made for method B",
  );
});

/**
 * A fake Stripe for the negative control: method A's create is SLOW (it hangs from our client's point of
 * view, but Stripe commits the charge the instant the request arrives -- the reviewer's own repro used a
 * "charges but answers late" stub for exactly this reason). Method B's create answers immediately and also
 * commits. There is no retry mechanism here at all -- this fake exists only to show what the PRE-FIX
 * control flow does when it reaches a second, healthy payment method after the first one went ambiguous.
 */
function fakeStripeSlowAThenFastB() {
  const calls: Call[] = [];
  const committed: string[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push({ url, key, method: String(init?.method) });
    if (url.endsWith("/payment_intents") && init?.method === "POST") {
      committed.push(key!); // Stripe processes every create it receives -- that is what makes this a double charge.
      if (key!.endsWith("pm_A")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ id: `pi_${key}`, status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls, committed };
}

Deno.test("NEGATIVE CONTROL (B1): the PRE-FIX shape -- any error (including a timeout) just moves to the next method -- DOES charge method B after A's ambiguous timeout", async () => {
  // This reconstructs the control flow index.ts had at PR #2198's reviewed head
  // (26674e89d42e87dc53ad71ba244940b171b7270b): `catch (e) { lastError = ...; continue; }` with no
  // distinction between a genuine decline and a timeout.
  const { fetchFn, calls, committed } = fakeStripeSlowAThenFastB();
  // deno-lint-ignore no-explicit-any
  let paymentIntentData: any = null;
  let lastError = "";
  for (const method of twoMethods) {
    const key = `plat-fee-${CLAIM}-${CONTRACTOR}-${method.stripe_payment_method_id}`;
    try {
      const r = await fetchStripeWithTimeout(fetchFn, `${API}/payment_intents`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: "amount=1000",
      }, 30);
      const rd = await r.json();
      if (!r.ok) { lastError = "declined"; continue; }
      paymentIntentData = rd;
      break;
    } catch (e) {
      // THE DEFECT: no check for WHICH kind of error this is -- a timeout is treated like a decline.
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
  }
  assertEquals(paymentIntentData?.id, "pi_plat-fee-claim1-ctr1-pm_B", "the pre-fix loop ends up 'succeeding' on method B");
  assertEquals(committed.length, 2, "REGRESSION: Stripe committed TWO charges -- method A (ambiguously, via the hang) AND method B");
  assert(calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"), "the pre-fix shape does send a create for method B");
});

Deno.test("gh-1886 B1: two timeouts in a row for the SAME method stop the WHOLE loop -- method B is never attempted", async () => {
  const calls: (string | null)[] = [];
  const alwaysHangs = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(headers["Idempotency-Key"] ?? null);
    if (!url.endsWith("/payment_intents")) return Promise.resolve(new Response("{}", { status: 200 }));
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;

  await assertRejects(
    () =>
      runOffSessionPlatformFeeCharge({
        fetchFn: alwaysHangs,
        apiBase: API,
        basicAuth: "QUJD",
        claimId: CLAIM,
        contractorId: CONTRACTOR,
        stripeCustomerId: "cus_1",
        currency: "usd",
        amount: 1000,
        methodsToTry: twoMethods,
        calculateCardChargeAmount: (c) => c,
        timeoutMs: 20,
      }),
    AmbiguousChargeOutcomeError,
  );
  assert(
    calls.every((k) => k === "plat-fee-claim1-ctr1-pm_A"),
    `only method A's key should ever have been sent, got: ${JSON.stringify(calls)}`,
  );
});

Deno.test("gh-1886: a genuine decline (Stripe answers immediately, no timeout at all) still falls through to the next method -- unchanged from before this PR", async () => {
  const calls: (string | null)[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push(key);
    if (url.endsWith("/payment_intents") && key?.endsWith("pm_A")) {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "Your card was declined." } }), { status: 402 }));
    }
    if (url.endsWith("/payment_intents")) {
      return Promise.resolve(new Response(JSON.stringify({ id: "pi_B", status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;

  const result = await runOffSessionPlatformFeeCharge({
    fetchFn,
    apiBase: API,
    basicAuth: "QUJD",
    claimId: CLAIM,
    contractorId: CONTRACTOR,
    stripeCustomerId: "cus_1",
    currency: "usd",
    amount: 1000,
    methodsToTry: twoMethods,
    calculateCardChargeAmount: (c) => c,
  });
  assertEquals(result.usedMethod.stripe_payment_method_id, "pm_B");
  assertEquals(calls.filter((k) => k?.endsWith("pm_A")).length, 1, "no retry on a genuine (non-timeout) decline");
});

// -- N1 (non-blocking): the overall loop deadline ------------------------------------------------------

Deno.test("gh-1886 N1: an exhausted loop deadline stops trying MORE methods, rather than risk Supabase's wall-clock limit", async () => {
  const calls: (string | null)[] = [];
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(headers["Idempotency-Key"] ?? null);
    return Promise.resolve(new Response(JSON.stringify({ error: { message: "declined" } }), { status: 402 }));
  }) as unknown as typeof fetch;
  const threeMethods = [
    { stripe_payment_method_id: "pm_A", payment_type: "card", id: null },
    { stripe_payment_method_id: "pm_B", payment_type: "card", id: null },
    { stripe_payment_method_id: "pm_C", payment_type: "card", id: null },
  ];
  let t = 0;
  const now = () => { t += 1; return t; };
  await assertRejects(
    () =>
      runOffSessionPlatformFeeCharge({
        fetchFn,
        apiBase: API,
        basicAuth: "QUJD",
        claimId: CLAIM,
        contractorId: CONTRACTOR,
        stripeCustomerId: "cus_1",
        currency: "usd",
        amount: 1000,
        methodsToTry: threeMethods,
        calculateCardChargeAmount: (c) => c,
        loopBudgetMs: 1,
        now,
      }),
    Error,
    "loop deadline",
  );
  assert(calls.length < threeMethods.length, `expected the deadline to cut the loop short, tried ${calls.length} of ${threeMethods.length}`);
});

Deno.test("gh-1886 N1: the production default loop budget fits inside Supabase's ~150s wall-clock limit", async () => {
  const { OFF_SESSION_LOOP_BUDGET_MS } = await import("./stripe-fetch.ts");
  assert(OFF_SESSION_LOOP_BUDGET_MS > 0 && OFF_SESSION_LOOP_BUDGET_MS <= 120_000, String(OFF_SESSION_LOOP_BUDGET_MS));
});

// -- B2(a): structural pinning of index.ts and off-session-charge.ts, in the style of standard-create-form.test.ts --

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const offSessionModule = await Deno.readTextFile(new URL("./off-session-charge.ts", import.meta.url));

Deno.test("gh-1886 B2(a): index.ts delegates the off-session loop to runOffSessionPlatformFeeCharge exactly once, and no longer inlines the per-method fetch", () => {
  assert(index.includes('from "./off-session-charge.ts"'));
  assertEquals(index.split("runOffSessionPlatformFeeCharge(").length - 1, 1);
  const start = index.indexOf('if (metadata.type === "platform_fee" && off_session && contractor_id)');
  const end = index.indexOf("} else {\n      // ===== Standard flow");
  assert(start > 0 && end > start, "could not locate the off-session branch in index.ts");
  const offSessionSection = index.slice(start, end);
  assert(!offSessionSection.includes("fetchStripeCreateWithRetry("), "the per-method create call must live in off-session-charge.ts, not inline in index.ts");
  assert(!/\bawait fetch\(/.test(offSessionSection), "no bare fetch() left in the off-session branch of index.ts");
});

Deno.test("gh-1886 B2(a): every Stripe network call in index.ts goes through a timeout wrapper -- no bare fetch() anywhere in the file", () => {
  const bareFetchCalls = [...index.matchAll(/\bawait fetch\(/g)];
  assertEquals(
    bareFetchCalls.length,
    0,
    `found ${bareFetchCalls.length} call(s) to a bare fetch() not going through fetchStripeWithTimeout / fetchStripeCreateWithRetry / runOffSessionPlatformFeeCharge`,
  );
  // Exactly one direct fetchStripeWithTimeout() call should remain in index.ts itself: the standard-flow
  // create. The off-session create AND its cancel are both inside off-session-charge.ts, reached through
  // the single runOffSessionPlatformFeeCharge() call asserted above -- together, all three Stripe call
  // sites in this function are accounted for and none of them is a bare fetch().
  assertEquals(index.split("fetchStripeWithTimeout(").length - 1, 1, "expected exactly one direct fetchStripeWithTimeout() call in index.ts (the standard-flow create)");
});

Deno.test("gh-1886 B2(a): off-session-charge.ts routes its create through fetchStripeCreateWithRetry and its cancel through fetchStripeWithTimeout -- no bare fetch()", () => {
  assertEquals(offSessionModule.split("fetchStripeCreateWithRetry(").length - 1, 1);
  assertEquals(offSessionModule.split("fetchStripeWithTimeout(").length - 1, 1);
  assert(!/\bawait\s+a\.fetchFn\(/.test(offSessionModule), "off-session-charge.ts must not call fetchFn directly, bypassing both wrappers");
});
