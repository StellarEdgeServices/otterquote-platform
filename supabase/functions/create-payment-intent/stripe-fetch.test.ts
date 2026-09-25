// gh-1886: proves the new timeout wrapper bounds a hung Stripe call, and that the
// pre-fix shape (a bare fetch with no signal) does not.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fetchStripeWithTimeout, STRIPE_FETCH_TIMEOUT_MS } from "./stripe-fetch.ts";

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
