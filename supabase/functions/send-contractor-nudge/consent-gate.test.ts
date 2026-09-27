// Deno unit tests for send-contractor-nudge's gh-1916 / D-328 consent gate.
// Run: deno test supabase/functions/send-contractor-nudge/consent-gate.test.ts
//
// gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44): get-contractor-info no
// longer returns a contractor's phone number or consent metadata to the
// browser at all — the nudge send moved entirely server-side, into this
// function. These are the negative control Marty's ruling asked for: "a
// non-consenting contractor is not texted; a consenting one is" — proven at
// the boundary that actually matters now, the call to send-sms, not a
// client-visible response field (there is none left to inspect for that).
//
// Fail-first proof: this module (consent-gate.ts) does not exist on PR head
// 11ffc5cf ("Module not found" running this file there) or on main. Every
// assertion below is new behavior this fix introduces.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { attemptContractorSms, isSmsConsented } from "./consent-gate.ts";

// ── isSmsConsented: the exact strict-equality gate ──────────────────────────

Deno.test("isSmsConsented: only literal true passes; false/null/undefined/truthy-non-boolean do not", () => {
  assertEquals(isSmsConsented(true), true);
  assertEquals(isSmsConsented(false), false);
  assertEquals(isSmsConsented(null), false);
  assertEquals(isSmsConsented(undefined), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented("true" as any), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented(1 as any), false);
});

// ── attemptContractorSms: a non-consenting contractor is NEVER texted ──────

function makeFetchSpy(ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ sid: "SM123" }), { status: ok ? 200 : 500 }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test("opted-out (false): refused — no fetch call is ever made, phone is never texted", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    false,
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

Deno.test("null (never asked, v115 default): refused — no fetch call is ever made", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    null,
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

Deno.test("undefined (field omitted): refused — no fetch call is ever made", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    undefined,
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

// ── attemptContractorSms: a genuinely consenting contractor IS texted ──────

Deno.test("opted-in (true): send-sms is called, via the service-role bearer, with the phone and message", async () => {
  const { fetchImpl, calls } = makeFetchSpy(true);
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello contractor",
    "ctr-1",
    true,
  );
  assertEquals(result, { attempted: true, ok: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://proj.supabase.co/functions/v1/send-sms");
  assertEquals(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers.Authorization, "Bearer service-role-key");
  assertEquals(JSON.parse(calls[0].init.body as string), {
    to: "+15551234567",
    message: "hello contractor",
  });
});

Deno.test("opted-in but send-sms itself fails: attempted true, ok false — the call was still made", async () => {
  const { fetchImpl, calls } = makeFetchSpy(false);
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    true,
  );
  assertEquals(result, { attempted: true, ok: false });
  assertEquals(calls.length, 1);
});
