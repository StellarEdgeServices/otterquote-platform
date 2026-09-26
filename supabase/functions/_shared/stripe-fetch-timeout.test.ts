// gh-2121 / PR #2226 REVIEW D14: the _shared copy of fetchStripeWithTimeout must stay identical to the original.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import * as copy from "./stripe-fetch-timeout.ts";
import * as original from "../create-payment-intent/stripe-fetch.ts";

Deno.test("the _shared copy is source-identical to create-payment-intent/stripe-fetch.ts", () => {
  assertEquals(copy.fetchStripeWithTimeout.toString(), original.fetchStripeWithTimeout.toString());
  assertEquals(copy.StripeFetchTimeoutError.toString(), original.StripeFetchTimeoutError.toString());
  assertEquals(copy.STRIPE_FETCH_TIMEOUT_MS, original.STRIPE_FETCH_TIMEOUT_MS);
});

Deno.test("the copy passes an AbortSignal and maps a hang to StripeFetchTimeoutError", async () => {
  let sawSignal = false;
  const hang: typeof fetch = (_u, init) =>
    new Promise((_res, rej) => {
      sawSignal = !!init?.signal;
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    });
  await assertRejects(() => copy.fetchStripeWithTimeout(hang, "https://api.stripe.com/v1/x", {}, 5), copy.StripeFetchTimeoutError);
  assert(sawSignal);
});
