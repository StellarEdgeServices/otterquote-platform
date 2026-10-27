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
// D-328's full condition is "opted in, current text version
// contractor-v2-2026-09-15", so the version cases below prove the second
// half: opted-in alone is not sufficient if the stored consent was captured
// under a superseded (or missing) text version.
//
// Fail-first proof: this module (consent-gate.ts) does not exist on PR head
// 11ffc5cf ("Module not found" running this file there) or on main. Every
// assertion below is new behavior this fix introduces. The version-gate
// cases specifically were run against the pre-fix attemptContractorSms
// (smsOptIn-only) and failed there — see the coordinator-follow-up HANDOFF
// for the captured failure output.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  attemptContractorSms,
  CURRENT_CONTRACTOR_SMS_CONSENT_VERSION,
  isSmsConsented,
} from "./consent-gate.ts";

// ── isSmsConsented: the exact strict-equality gate ──────────────────────────

Deno.test("isSmsConsented: true requires BOTH sms_opt_in===true AND the current consent text version", () => {
  assertEquals(isSmsConsented(true, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), true);
  assertEquals(isSmsConsented(false, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), false);
  assertEquals(isSmsConsented(null, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), false);
  assertEquals(isSmsConsented(undefined, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented("true" as any, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented(1 as any, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION), false);
  // opted-in but the version is stale, missing, or blank — all refuse.
  assertEquals(isSmsConsented(true, "contractor-v1-2026-09-14"), false);
  assertEquals(isSmsConsented(true, null), false);
  assertEquals(isSmsConsented(true, undefined), false);
  assertEquals(isSmsConsented(true, ""), false);
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
    CURRENT_CONTRACTOR_SMS_CONSENT_VERSION,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
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
    null,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

Deno.test("undefined (fields omitted): refused — no fetch call is ever made", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    undefined,
    undefined,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

// ── attemptContractorSms: opted in but the consent TEXT VERSION doesn't
// match — coordinator follow-up on PR #2252 / RETURNED 5856782745's full
// condition ("opted in, current text version contractor-v2-2026-09-15") ────

Deno.test("opted-in but consent text version is OLD (contractor-v1-2026-09-14): refused — no fetch call is ever made", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    true,
    "contractor-v1-2026-09-14",
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

Deno.test("opted-in but consent text version is null: refused — no fetch call is ever made", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    true,
    null,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});

// ── attemptContractorSms: a genuinely, currently consenting contractor IS
// texted ─────────────────────────────────────────────────────────────────

Deno.test("opted-in with the CURRENT consent text version: send-sms is called, via the service-role bearer, with the phone and message", async () => {
  const { fetchImpl, calls } = makeFetchSpy(true);
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello contractor",
    "ctr-1",
    true,
    CURRENT_CONTRACTOR_SMS_CONSENT_VERSION,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
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

Deno.test("opted-in + current version but send-sms itself fails: attempted true, ok false — the call was still made", async () => {
  const { fetchImpl, calls } = makeFetchSpy(false);
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello",
    "ctr-1",
    true,
    CURRENT_CONTRACTOR_SMS_CONSENT_VERSION,
    true, // isTest: gh-2875 gate passes, so these cases isolate the consent gate
  );
  assertEquals(result, { attempted: true, ok: false });
  assertEquals(calls.length, 1);
});

// -- D-391 / #2875: TCR release gate (is_test-only until CONTRACTOR_SMS_TCR_RELEASED === "true") ------------------

const CONSENTED = [true, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION] as const;
const envOf = (v: string | undefined) => (_n: string) => v;

async function nudge(isTest: boolean | null | undefined, released: string | undefined) {
  const { fetchImpl, calls } = makeFetchSpy(true);
  const logs: string[] = [];
  const result = await attemptContractorSms(
    fetchImpl,
    "https://proj.supabase.co",
    "service-role-key",
    "+15551234567",
    "hello contractor",
    "ctr-1",
    CONSENTED[0],
    CONSENTED[1],
    isTest,
    { getEnv: envOf(released), log: (l) => logs.push(l) },
  );
  return { result, calls, logs };
}

Deno.test("gh-2875: consented NON-test contractor, switch unset -> refused, send-sms never called, masked refusal logged", async () => {
  const { result, calls, logs } = await nudge(false, undefined);
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].includes("1234567"), false, "full number must never be logged");
  assertEquals(logs[0].includes("***4567"), true);
  assertEquals(logs[0].includes("send-contractor-nudge/consent-gate"), true);
});

Deno.test("gh-2875: is_test null / undefined (unreadable) fails closed", async () => {
  for (const v of [null, undefined]) {
    const { result, calls } = await nudge(v, undefined);
    assertEquals(result, { attempted: false, ok: false });
    assertEquals(calls.length, 0);
  }
});

Deno.test("gh-2875: switch values other than the exact string 'true' do not release", async () => {
  for (const v of ["", "1", "TRUE", "yes", "false"]) {
    const { calls } = await nudge(false, v);
    assertEquals(calls.length, 0, `released=${JSON.stringify(v)}`);
  }
});

Deno.test("gh-2875: consented is_test contractor IS texted (test traffic only reaches test contractors)", async () => {
  const { result, calls } = await nudge(true, undefined);
  assertEquals(result, { attempted: true, ok: true });
  assertEquals(calls.length, 1);
});

Deno.test("gh-2875: switch 'true' releases a consented non-test contractor", async () => {
  const { result, calls } = await nudge(false, "true");
  assertEquals(result, { attempted: true, ok: true });
  assertEquals(calls.length, 1);
});

Deno.test("gh-2875: is_test never bypasses the consent gate (test contractor with no opt-in is still refused)", async () => {
  const { fetchImpl, calls } = makeFetchSpy();
  const result = await attemptContractorSms(
    fetchImpl, "https://proj.supabase.co", "service-role-key", "+15551234567", "hello", "ctr-1",
    false, CURRENT_CONTRACTOR_SMS_CONSENT_VERSION, true, { getEnv: envOf("true") },
  );
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});
