// gh-1886 B1/B2 (independent review on #2198, 2026-09-25; re-reviewed and returned again on
// 2026-09-25T22:02:35Z with head ba263c4e).
//
// B1: a timeout on a CONFIRMED off-session create does not mean Stripe did not charge the card/bank
// account -- it only means this function stopped waiting. The FIRST rework (ba263c4e) fixed the double
// TIMEOUT case (retry once under the same Idempotency-Key, then stop the whole loop) but still let three
// OTHER non-definitive outcomes fall through to the next payment method: a 409 idempotency_error on the
// retry, a 429/5xx, and a thrown network error after the request was sent. Every one of those is now
// classified ambiguous by fetchStripeCreateWithRetry (stripe-fetch.ts) and stops the whole loop instead.
//
// B2: this file drives the REAL runOffSessionPlatformFeeCharge (extracted from index.ts) against fake
// Stripe stubs, so every double-charge reproduction below is a real behavioural test, not a source-text
// assertion. It also pins index.ts and off-session-charge.ts structurally, mirroring
// standard-create-form.test.ts's "index.ts uses them, and only them" pattern in this same folder.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AmbiguousChargeOutcomeError, runOffSessionPlatformFeeCharge } from "./off-session-charge.ts";
import { fetchStripeWithTimeout } from "./stripe-fetch.ts";

const API = "https://api.stripe.com/v1";
const CLAIM = "claim1";
const CONTRACTOR = "ctr1";

interface Call { url: string; key: string | null; method: string }

const twoMethods = [
  { stripe_payment_method_id: "pm_A", payment_type: "card", id: "m1" },
  { stripe_payment_method_id: "pm_B", payment_type: "us_bank_account", id: "m2" },
];

/**
 * Reconstructs the create-attempt/retry policy at PR #2198's SECOND reviewed head (ba263c4e -- the FIRST
 * rework, before THIS one): retries ONCE, but ONLY on a StripeFetchTimeoutError. Any OTHER outcome -- a
 * normal (non-ok) HTTP response of ANY status (402, 409, 429, 5xx, ...) or a thrown non-timeout error -- is
 * handed straight back to the caller, which (ba263c4e's off-session loop, reconstructed in
 * ba263c4eStyleLoop below) treats it exactly like a genuine decline and falls through to the next method.
 */
async function ba263c4eStyleAttempt(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetchStripeWithTimeout(fetchFn, url, init, timeoutMs);
  } catch (e) {
    if (e instanceof Error && e.name === "StripeFetchTimeoutError") {
      return await fetchStripeWithTimeout(fetchFn, url, init, timeoutMs); // ba263c4e's one retry, same key
    }
    throw e; // ba263c4e: any OTHER thrown error propagates straight out -- no retry.
  }
}

// deno-lint-ignore no-explicit-any
async function ba263c4eStyleLoop(fetchFn: typeof fetch, methods: typeof twoMethods, timeoutMs = 30): Promise<{ paymentIntentData: any; lastError: string }> {
  // deno-lint-ignore no-explicit-any
  let paymentIntentData: any = null;
  let lastError = "";
  for (const method of methods) {
    const key = `plat-fee-${CLAIM}-${CONTRACTOR}-${method.stripe_payment_method_id}`;
    try {
      const r = await ba263c4eStyleAttempt(fetchFn, `${API}/payment_intents`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: "amount=1000",
      }, timeoutMs);
      const rd = await r.json();
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; } // ba263c4e: 409/429/5xx are ALL just "declines"
      paymentIntentData = rd;
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e); // ba263c4e: a thrown network error also just "declines"
      continue;
    }
  }
  return { paymentIntentData, lastError };
}

function runFixed(fetchFn: typeof fetch, timeoutMs = 30) {
  return runOffSessionPlatformFeeCharge({
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
    calculateCardChargeAmount: (c) => c,
    timeoutMs,
  });
}

// ============================================================================================
// B1 (first rework, ba263c4e): the double-timeout case -- already fixed before this re-review.
// ============================================================================================

/**
 * A fake Stripe where the FIRST create attempt for any given Idempotency-Key hangs (rejects only when
 * aborted) but ALSO marks the charge "committed" the instant that first attempt is made -- simulating a
 * real off-session confirmed charge that Stripe processes even though our client never sees the answer. A
 * SECOND attempt with the SAME key is Stripe's documented idempotent replay: it returns the same
 * PaymentIntent, with no new commit.
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
        committed.push(key!);
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

Deno.test("gh-1886 B1 fix: a timeout on method A's create NEVER produces a create for method B; the same-key retry recovers method A's own charge", async () => {
  const { fetchFn, calls, committed } = fakeAmbiguousStripe();
  const result = await runFixed(fetchFn);
  assertEquals(result.usedMethod.stripe_payment_method_id, "pm_A");
  assertEquals(result.paymentIntentData.id, "pi_plat-fee-claim1-ctr1-pm_A");
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A"], "Stripe committed exactly ONE charge, for method A");
  assert(!calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"), "method B's Idempotency-Key was never sent");
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
  await assertRejects(() => runFixed(alwaysHangs, 20), AmbiguousChargeOutcomeError);
  assert(calls.every((k) => k === "plat-fee-claim1-ctr1-pm_A"), `only method A's key should ever have been sent, got: ${JSON.stringify(calls)}`);
});

Deno.test("gh-1886: a genuine decline (402 card_error, no timeout at all) still falls through to the next method -- unchanged from before this PR", async () => {
  const calls: (string | null)[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push(key);
    if (url.endsWith("/payment_intents") && key?.endsWith("pm_A")) {
      return Promise.resolve(new Response(JSON.stringify({ error: { type: "card_error", message: "Your card was declined." } }), { status: 402 }));
    }
    if (url.endsWith("/payment_intents")) {
      return Promise.resolve(new Response(JSON.stringify({ id: "pi_B", status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  const result = await runFixed(fetchFn);
  assertEquals(result.usedMethod.stripe_payment_method_id, "pm_B");
  assertEquals(calls.filter((k) => k?.endsWith("pm_A")).length, 1, "no retry on a genuine (non-ambiguous) decline");
});

// ============================================================================================
// gh-1886 re-review #2 (2026-09-25T22:02:35Z, head ba263c4e): three MORE double-charge routes.
// Each fake below reproduces the reviewer's own three repro cases (R1/R2/R3) against
// ba263c4eStyleLoop (proving the bug existed on the head that was just returned) AND against the REAL
// runOffSessionPlatformFeeCharge (proving it is fixed).
// ============================================================================================

/** R1: pm_A's first attempt hangs-but-commits (Stripe genuinely begins processing it, even though our
 *  client never sees an answer); the SAME-KEY RETRY gets Stripe's 409 idempotency_error (another request
 *  under this key is still in progress at Stripe) instead of a real answer -- exactly the reviewer's own
 *  repro ("the retry fires 20s after the first create was sent... Stripe answers that retry with 409"). A
 *  fresh fetch to pm_B's own (different) key answers immediately and succeeds. */
function fakeStripe409OnRetry() {
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
      if (key!.endsWith("pm_A")) {
        if (n === 1) {
          committed.push(key!); // the ONE real charge attempt Stripe actually begins processing
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        // The retry does NOT create a second charge -- it is Stripe reporting that the FIRST one (above)
        // is still in progress. Nothing new is committed here.
        return Promise.resolve(new Response(JSON.stringify({ error: { type: "idempotency_error", message: "in progress" } }), { status: 409 }));
      }
      committed.push(key!); // pm_B's own, independent charge
      return Promise.resolve(new Response(JSON.stringify({ id: `pi_${key}`, status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls, committed };
}

Deno.test("gh-1886 re-review #2 NEGATIVE CONTROL (R1, 409-on-retry): the ba263c4e shape DOES charge method B after A's retry comes back 409 idempotency_error", async () => {
  const { fetchFn, calls, committed } = fakeStripe409OnRetry();
  const { paymentIntentData } = await ba263c4eStyleLoop(fetchFn, twoMethods);
  assertEquals(paymentIntentData?.id, "pi_plat-fee-claim1-ctr1-pm_B", "ba263c4e's loop 'succeeds' on method B");
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A", "plat-fee-claim1-ctr1-pm_B"], "REGRESSION-ON-ba263c4e: Stripe committed TWO real charges");
  assert(calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"), "ba263c4e's shape does send a create for method B");
});

Deno.test("gh-1886 re-review #2 fix (R1, 409-on-retry): the REAL loop throws AmbiguousChargeOutcomeError and NEVER creates method B", async () => {
  const { fetchFn, calls, committed } = fakeStripe409OnRetry();
  await assertRejects(() => runFixed(fetchFn), AmbiguousChargeOutcomeError);
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A"], "Stripe committed exactly ONE charge, for method A");
  assert(!calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"), "method B's Idempotency-Key was never sent");
});

/** R2: pm_A answers IMMEDIATELY (no timeout at all) with an indeterminate 500, on every attempt --
 *  simulating Stripe having received and begun processing the request before its own infrastructure
 *  failed to answer cleanly. `committed` records ONE entry per key the first time Stripe sees it (its own
 *  first processing attempt) -- a same-key retry is Stripe re-examining the SAME attempt, not a second
 *  charge. pm_B's own, different key gets its own, independent commit. */
function fakeStripe500OnA() {
  const calls: Call[] = [];
  const committed: string[] = [];
  const seen = new Set<string>();
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push({ url, key, method: String(init?.method) });
    if (url.endsWith("/payment_intents") && init?.method === "POST") {
      if (!seen.has(key!)) { seen.add(key!); committed.push(key!); }
      if (key!.endsWith("pm_A")) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "Internal server error" } }), { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: `pi_${key}`, status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls, committed };
}

Deno.test("gh-1886 re-review #2 NEGATIVE CONTROL (R2, Stripe 5xx on A): the ba263c4e shape DOES charge method B after A's indeterminate 500", async () => {
  const { fetchFn, calls, committed } = fakeStripe500OnA();
  const { paymentIntentData } = await ba263c4eStyleLoop(fetchFn, twoMethods);
  assertEquals(paymentIntentData?.id, "pi_plat-fee-claim1-ctr1-pm_B");
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A", "plat-fee-claim1-ctr1-pm_B"], "REGRESSION-ON-ba263c4e: Stripe committed TWO charges");
  assert(calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"));
});

Deno.test("gh-1886 re-review #2 fix (R2, Stripe 5xx on A): the REAL loop throws AmbiguousChargeOutcomeError and NEVER creates method B", async () => {
  const { fetchFn, calls, committed } = fakeStripe500OnA();
  await assertRejects(() => runFixed(fetchFn), AmbiguousChargeOutcomeError);
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A"]);
  assert(!calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"));
});

/** R3: pm_A's create is received (committed) and THEN the connection resets (a thrown, non-timeout,
 *  network error) on every attempt -- simulating a connection reset after the request was already sent.
 *  `committed` records ONE entry per key on its first attempt, same reasoning as fakeStripe500OnA. pm_B's
 *  own key answers immediately and gets its own, independent commit. */
function fakeStripeResetAfterSendOnA() {
  const calls: Call[] = [];
  const committed: string[] = [];
  const seen = new Set<string>();
  const fetchFn = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    calls.push({ url, key, method: String(init?.method) });
    if (url.endsWith("/payment_intents") && init?.method === "POST") {
      if (!seen.has(key!)) { seen.add(key!); committed.push(key!); }
      if (key!.endsWith("pm_A")) {
        return Promise.reject(new Error("read ECONNRESET"));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: `pi_${key}`, status: "succeeded" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls, committed };
}

Deno.test("gh-1886 re-review #2 NEGATIVE CONTROL (R3, ECONNRESET after send on A): the ba263c4e shape DOES charge method B after A's connection reset", async () => {
  const { fetchFn, calls, committed } = fakeStripeResetAfterSendOnA();
  const { paymentIntentData } = await ba263c4eStyleLoop(fetchFn, twoMethods);
  assertEquals(paymentIntentData?.id, "pi_plat-fee-claim1-ctr1-pm_B");
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A", "plat-fee-claim1-ctr1-pm_B"], "REGRESSION-ON-ba263c4e: Stripe committed TWO charges");
  assert(calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"));
});

Deno.test("gh-1886 re-review #2 fix (R3, ECONNRESET after send on A): the REAL loop throws AmbiguousChargeOutcomeError and NEVER creates method B", async () => {
  const { fetchFn, calls, committed } = fakeStripeResetAfterSendOnA();
  await assertRejects(() => runFixed(fetchFn), AmbiguousChargeOutcomeError);
  assertEquals(committed, ["plat-fee-claim1-ctr1-pm_A"]);
  assert(!calls.some((c) => c.key === "plat-fee-claim1-ctr1-pm_B"));
});

// ============================================================================================
// N1 (the overall loop deadline) -- both the start-of-method gate and the new hard per-call capping.
// ============================================================================================

Deno.test("gh-1886 N1: an exhausted loop deadline stops trying MORE methods, rather than risk Supabase's wall-clock limit", async () => {
  const calls: (string | null)[] = [];
  const fetchFn = ((_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(headers["Idempotency-Key"] ?? null);
    return Promise.resolve(new Response(JSON.stringify({ error: { type: "card_error", message: "declined" } }), { status: 402 }));
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
        fetchFn, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, contractorId: CONTRACTOR,
        stripeCustomerId: "cus_1", currency: "usd", amount: 1000,
        methodsToTry: threeMethods, calculateCardChargeAmount: (c) => c,
        loopBudgetMs: 1, now,
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

Deno.test("gh-1886 re-review #2 (N1 hard deadline): the cancel after a requires_action is capped to the REMAINING overall budget, not the full per-call timeoutMs", async () => {
  // Nominal per-call timeout is large (1000ms); the overall loop budget is small (150ms). If the cancel's
  // timeout were still the fixed nominal value (the pre-fix behaviour the reviewer flagged), a hanging
  // cancel would run for ~1000ms -- ~850ms past the deadline. With the fix, it is capped to whatever is
  // left (~150ms minus the near-instant create), so total elapsed stays close to the loop budget.
  const calls: string[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url.endsWith("/cancel") ? "cancel" : "create"}`);
    if (url.endsWith("/cancel")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "pi_A", status: "requires_action" }), { status: 200 }));
  }) as unknown as typeof fetch;

  const start = performance.now();
  await assertRejects(
    () =>
      runOffSessionPlatformFeeCharge({
        fetchFn, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, contractorId: CONTRACTOR,
        stripeCustomerId: "cus_1", currency: "usd", amount: 1000,
        methodsToTry: [twoMethods[0]], calculateCardChargeAmount: (c) => c,
        timeoutMs: 1000, loopBudgetMs: 150,
      }),
    Error, // only one method, requires_action -> cancel -> continue -> "All 1 payment methods failed"
  );
  const elapsed = performance.now() - start;
  assert(calls.includes("POST cancel"), "the cancel must actually have been attempted");
  assert(elapsed < 400, `expected the cancel's timeout to be capped near the ~150ms loop budget, not the nominal 1000ms, took ${elapsed}ms`);
});

Deno.test("gh-1886 re-review #2 (N1 hard deadline): the create's own timeout and its internal same-key retry are ALSO capped to the remaining budget, not the nominal per-call timeoutMs", async () => {
  // Nominal per-call timeout is large (1000ms) but the whole loop budget is only 120ms. A hanging create
  // must therefore abort near 120ms (not 1000ms), and by the time a retry would be attempted there is
  // nothing left, so the retry is never even sent.
  const calls: number[] = [];
  const alwaysHangs = ((_url: string, init?: RequestInit) => {
    calls.push(1);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;

  const start = performance.now();
  await assertRejects(
    () =>
      runOffSessionPlatformFeeCharge({
        fetchFn: alwaysHangs, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, contractorId: CONTRACTOR,
        stripeCustomerId: "cus_1", currency: "usd", amount: 1000,
        methodsToTry: [twoMethods[0]], calculateCardChargeAmount: (c) => c,
        timeoutMs: 1000, loopBudgetMs: 120,
      }),
    AmbiguousChargeOutcomeError,
  );
  const elapsed = performance.now() - start;
  assertEquals(calls.length, 1, "the retry has nothing left of the 120ms overall budget after the first (capped) attempt, so it must never be sent");
  assert(elapsed < 500, `expected the capped attempt to abort near the 120ms loop budget, not the nominal 1000ms timeoutMs, took ${elapsed}ms`);
});

// ============================================================================================
// B2(a): structural pinning of index.ts and off-session-charge.ts, in the style of
// standard-create-form.test.ts. Extended (re-review #2) to also pin the new AmbiguousChargeOutcomeError
// routing in index.ts.
// ============================================================================================

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
  assertEquals(bareFetchCalls.length, 0, `found ${bareFetchCalls.length} call(s) to a bare fetch() not going through a timeout wrapper`);
  assertEquals(index.split("fetchStripeWithTimeout(").length - 1, 1, "expected exactly one direct fetchStripeWithTimeout() call in index.ts (the standard-flow create)");
});

Deno.test("gh-1886 B2(a): off-session-charge.ts routes its create through fetchStripeCreateWithRetry and its cancel through fetchStripeWithTimeout -- no bare fetch()", () => {
  assertEquals(offSessionModule.split("fetchStripeCreateWithRetry(").length - 1, 1);
  assertEquals(offSessionModule.split("fetchStripeWithTimeout(").length - 1, 1);
  assert(!/\bawait\s+a\.fetchFn\(/.test(offSessionModule), "off-session-charge.ts must not call fetchFn directly, bypassing both wrappers");
});

Deno.test("gh-1886 re-review #2 (B1-c) B2(a): index.ts catches AmbiguousChargeOutcomeError from the off-session call and returns a distinct 422, mirroring the #1467 guard-refusal shape -- it is never left to the generic 500", () => {
  assert(index.includes("AmbiguousChargeOutcomeError"), "index.ts must import/reference AmbiguousChargeOutcomeError");
  const tryAt = index.indexOf("offSessionResult = await runOffSessionPlatformFeeCharge(");
  assert(tryAt > -1, "the off-session call must be inside its own try so the ambiguous-outcome catch can be attached to it specifically");
  const catchAt = index.indexOf("} catch (e) {", tryAt);
  assert(catchAt > -1 && catchAt < tryAt + 2000, "no catch found immediately after the off-session call");
  const tail = index.slice(catchAt, catchAt + 1500);
  assertEquals(tail.includes("e instanceof AmbiguousChargeOutcomeError"), true);
  assertEquals(tail.includes("status: 422"), true, "the ambiguous-outcome response must be a 422, mirroring the #1467 guard-refusal 422 -- never the generic 500");
  assertEquals(tail.includes("AMBIGUOUS_OUTCOME_CODE"), true);
  assertEquals(tail.includes("throw e;"), true, "every OTHER error from the off-session call must still propagate to the outer catch (unchanged 500 path)");
});
