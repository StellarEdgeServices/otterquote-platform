// gh-1886: proves the new timeout wrapper bounds a hung Stripe call, and that the
// pre-fix shape (a bare fetch with no signal) does not.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AmbiguousChargeOutcomeError,
  fetchStripeCreateWithRetry,
  fetchStripeWithTimeout,
  STRIPE_FETCH_TIMEOUT_MS,
} from "./stripe-fetch.ts";

Deno.test("fetchStripeWithTimeout aborts a hung Stripe call within the given budget", async () => {
  let sawAbort = false;
  const hangingFetch = ((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        sawAbort = true;
        reject(new DOMException("The signal has been aborted", "AbortError"));
      });
      // deliberately never resolves/rejects on its own -- simulates a hung connection
    });
  }) as unknown as typeof fetch;

  const start = performance.now();
  await assertRejects(
    () =>
      fetchStripeWithTimeout(
        hangingFetch,
        "https://api.stripe.com/v1/payment_intents",
        { method: "POST", body: "amount=1000" },
        50, // short budget so the test itself stays fast; production uses STRIPE_FETCH_TIMEOUT_MS
      ),
    Error,
    "Stripe request timed out after 50ms",
  );
  const elapsed = performance.now() - start;
  assert(sawAbort, "the wrapper must actually abort the hung request via the signal, not just give up locally");
  assert(elapsed < 2000, `timeout should fire near the 50ms budget, took ${elapsed}ms`);
});

Deno.test("fetchStripeWithTimeout passes through success unchanged", async () => {
  const okFetch = ((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ id: "pi_123", status: "succeeded" }), { status: 200 }))) as unknown as
    typeof fetch;
  const r = await fetchStripeWithTimeout(okFetch, "https://api.stripe.com/v1/payment_intents", { method: "POST" });
  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.id, "pi_123");
});

Deno.test("the production default is a real bound, not effectively infinite", () => {
  assert(STRIPE_FETCH_TIMEOUT_MS > 0 && STRIPE_FETCH_TIMEOUT_MS <= 30_000, "budget must fit inside a typical 30s client timeout");
});

Deno.test("NEGATIVE CONTROL: a bare fetch call with no signal never settles within the same budget -- this is the pre-fix shape", async () => {
  const hangingFetch = ((_url: string, _init?: RequestInit) => new Promise<Response>(() => {})) as unknown as typeof fetch;
  // This is exactly what index.ts called before gh-1886: `await fetch(url, { method, headers, body })`
  // with no `signal` in the init at all. There is nothing here that CAN time it out.
  const raced = await Promise.race([
    hangingFetch("https://api.stripe.com/v1/payment_intents", { method: "POST" }).then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("still-pending-after-budget"), 100)),
  ]);
  assertEquals(
    raced,
    "still-pending-after-budget",
    "pre-fix: an unbounded fetch() is still pending after the same budget that fetchStripeWithTimeout enforces",
  );
});

// -- gh-1886 B1 (independent review on #2198, 2026-09-25, head ba263c4e): fetchStripeCreateWithRetry -----
function keyOf(init: RequestInit): string | null {
  return (init.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
}

Deno.test("fetchStripeCreateWithRetry: a first timeout retries the SAME request once, under the SAME Idempotency-Key, and returns the retry's response", async () => {
  const calls: RequestInit[] = [];
  let attempt = 0;
  const fetchFn = ((_url: string, init?: RequestInit) => {
    calls.push(init ?? {});
    attempt++;
    if (attempt === 1) {
      // First attempt: hangs until aborted (a timeout).
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    // Retry: Stripe's documented idempotent replay -- same key, answers with the ORIGINAL PaymentIntent.
    return Promise.resolve(new Response(JSON.stringify({ id: "pi_A", status: "succeeded" }), { status: 200 }));
  }) as unknown as typeof fetch;

  const init: RequestInit = { method: "POST", headers: { "Idempotency-Key": "plat-fee-claim1-ctr1-pm_A" }, body: "amount=1000" };
  const { response: r, body } = await fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", init, 30);
  assertEquals(r.status, 200);
  assertEquals(body.id, "pi_A", "the retry recovers the ORIGINAL PaymentIntent, not a new one");
  assertEquals(calls.length, 2, "exactly two attempts: the timed-out one and its retry");
  assertEquals(keyOf(calls[0]), keyOf(calls[1]), "both attempts carry the identical Idempotency-Key");
});

Deno.test("fetchStripeCreateWithRetry: two timeouts in a row throw AmbiguousChargeOutcomeError, not a decline", async () => {
  const hangingFetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  await assertRejects(
    () => fetchStripeCreateWithRetry(hangingFetch, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 20),
    AmbiguousChargeOutcomeError,
  );
});

Deno.test("fetchStripeCreateWithRetry: a genuine Stripe decline (402 card_error, no timeout at all) is returned unchanged, with no retry", async () => {
  const calls: string[] = [];
  const declineFetch = ((url: string, _init?: RequestInit) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify({ error: { type: "card_error", message: "Your card was declined." } }), { status: 402 }));
  }) as unknown as typeof fetch;
  const { response: r, body } = await fetchStripeCreateWithRetry(declineFetch, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 30);
  assertEquals(r.status, 402);
  assertEquals(body.error.type, "card_error");
  assertEquals(calls.length, 1, "a genuine decline is not ambiguous: no retry is attempted");
});

// -- gh-1886 re-review #2 (independent review on #2198, 2026-09-25T22:02:35Z): B1-a/B1-b -------------------
// "Treat EVERY non-definitive outcome after the create request may have reached Stripe as AMBIGUOUS, not
// as a decline: a timeout, 409 idempotency_error / in-progress, 429, any 5xx, and a network error after
// send." These four tests are the negative controls at the fetchStripeCreateWithRetry level: on head
// ba263c4e (the FIRST rework), none of 409/429/5xx/a-thrown-non-timeout-error retried or stopped anything
// -- a 409/429/5xx response was just returned as a normal (non-ok) Response, and any non-timeout thrown
// error propagated immediately -- so off-session-charge.ts's `!r.ok -> continue` / `catch -> continue`
// moved straight to the next payment method in every one of these cases. off-session-charge.test.ts proves
// the resulting double charge at the loop level; these four prove the underlying misclassification is
// fixed at its source.

Deno.test("gh-1886 re-review #2 (B1-a): a 409 (idempotency_error -- Stripe still processing an earlier attempt) is ambiguous, not a decline -- it retries, and a second 409 throws AmbiguousChargeOutcomeError", async () => {
  const calls: number[] = [];
  const fetchFn = ((_url: string, _init?: RequestInit) => {
    calls.push(1);
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "idempotency_error", message: "another request in progress" } }), { status: 409 }),
    );
  }) as unknown as typeof fetch;
  await assertRejects(
    () => fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", { method: "POST", headers: { "Idempotency-Key": "k" } }, 30),
    AmbiguousChargeOutcomeError,
  );
  assertEquals(calls.length, 2, "a 409 is retried once (same key) before giving up, exactly like a timeout");
});

Deno.test("gh-1886 re-review #2 (B1-a): a 409 on the FIRST attempt that resolves decisively on retry is NOT ambiguous overall -- the retry's real answer is returned", async () => {
  let attempt = 0;
  const fetchFn = ((_url: string, _init?: RequestInit) => {
    attempt++;
    if (attempt === 1) {
      return Promise.resolve(new Response(JSON.stringify({ error: { type: "idempotency_error" } }), { status: 409 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "pi_A", status: "succeeded" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const { response: r, body } = await fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 30);
  assertEquals(r.status, 200);
  assertEquals(body.id, "pi_A");
});

Deno.test("gh-1886 re-review #2 (B1-b): a 429 (rate limited) is ambiguous, not a decline", async () => {
  const fetchFn = ((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))) as unknown as typeof fetch;
  await assertRejects(
    () => fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 30),
    AmbiguousChargeOutcomeError,
  );
});

Deno.test("gh-1886 re-review #2 (B1-b): any 5xx is ambiguous, not a decline", async () => {
  const fetchFn = ((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ error: { message: "internal error" } }), { status: 500 }))) as unknown as typeof fetch;
  await assertRejects(
    () => fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 30),
    AmbiguousChargeOutcomeError,
  );
});

Deno.test("gh-1886 re-review #2 (B1-b): a thrown network error after fetchFn was called (e.g. ECONNRESET) is ambiguous -- it retries, and a second one throws AmbiguousChargeOutcomeError", async () => {
  const calls: number[] = [];
  const fetchFn = ((_url: string, _init?: RequestInit) => {
    calls.push(1);
    return Promise.reject(new Error("read ECONNRESET"));
  }) as unknown as typeof fetch;
  await assertRejects(
    () => fetchStripeCreateWithRetry(fetchFn, "https://api.stripe.com/v1/payment_intents", { method: "POST" }, 30),
    AmbiguousChargeOutcomeError,
  );
  assertEquals(calls.length, 2, "a thrown network error is retried once before giving up, exactly like a timeout -- this is a deliberate behaviour change from the very first gh-1886 patch, which propagated a non-timeout exception immediately with no retry");
});

// -- gh-1886 re-review #2 (N1): the hard deadline is enforced INSIDE fetchStripeCreateWithRetry too -------

Deno.test("gh-1886 re-review #2 (N1): getRemainingMs caps each attempt's own timeout, and a second attempt with nothing left is never even sent", async () => {
  const calls: number[] = [];
  const alwaysHangs = ((_url: string, init?: RequestInit) => {
    calls.push(1);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;

  // Simulates the overall deadline being consumed by the first (capped) attempt: 50ms remains when the
  // first attempt starts, 0ms remains by the time a retry would start.
  let remainingCalls = 0;
  const getRemainingMs = () => (remainingCalls++ === 0 ? 50 : 0);

  const start = performance.now();
  await assertRejects(
    () =>
      fetchStripeCreateWithRetry(
        alwaysHangs,
        "https://api.stripe.com/v1/payment_intents",
        { method: "POST" },
        1000, // nominal per-call timeout is large...
        getRemainingMs, // ...but the overall deadline leaves far less, and nothing at all for the retry
      ),
    AmbiguousChargeOutcomeError,
  );
  const elapsed = performance.now() - start;
  assertEquals(calls.length, 1, "the first attempt is capped to the 50ms remaining budget and sent once; the retry has nothing left and must not be sent at all");
  assert(elapsed < 500, `expected the capped attempt to abort near 50ms, not run anywhere near the nominal 1000ms timeout, took ${elapsed}ms`);
});
