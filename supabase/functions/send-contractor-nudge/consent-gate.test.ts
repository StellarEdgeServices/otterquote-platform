// Deno unit tests for send-contractor-nudge's contractor SMS path.
// Run: deno test supabase/functions/send-contractor-nudge/consent-gate.test.ts
//
// D-391 / #2875 layer 4 REPLACED the gh-1916 / D-328 sms_opt_in + consent-text-version gate: the nudge texts ONLY
// numbers returned by contractor_textable_numbers() (via resolveNudgeRecipients), behind the is_test / TCR release gate.
// NEGATIVE CONTROL: a contractor with sms_opt_in = true, the legacy consent version and a phone on file, but NO
// verified number, gets NO send-sms call; a contractor with a verified number DOES.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { attemptContractorSms, resolveNudgeRecipients } from "./consent-gate.ts";
import { resolveContractorTextableNumbers, type TextableClient } from "../_shared/contractor-textable.ts";

function makeFetchSpy(ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ sid: "SM123" }), { status: ok ? 200 : 500 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

type Row = { number_id: string; phone_e164: string; is_primary: boolean };

/** A fake service-role client. `verified` is what contractor_textable_numbers() returns. */
function fakeClient(verified: Row[], rpcError = false) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const sb: TextableClient = {
    rpc(fn, args) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: rpcError ? null : verified, error: rpcError ? { message: "boom" } : null });
    },
    from(_table: string) {
      return {
        select: () => ({
          in: () =>
            Promise.resolve({
              data: verified.map((v) => ({ id: v.number_id, verified_at: "2026-10-01T00:00:00Z", disclosure_version_id: "v-test" })),
            }),
        }),
      };
    },
  };
  return { sb, rpcCalls };
}

const envOf = (v: string | undefined) => (_n: string) => v;
const V1: Row = { number_id: "n1", phone_e164: "+15155550142", is_primary: true };

/** The whole nudge recipient path: resolve, then attempt each. */
async function nudge(opts: { verified: Row[]; isTest: boolean | null | undefined; released?: string; rpcError?: boolean }) {
  const { fetchImpl, calls } = makeFetchSpy(true);
  const { sb, rpcCalls } = fakeClient(opts.verified, opts.rpcError);
  const logs: string[] = [];
  const gate = { getEnv: envOf(opts.released), log: (l: string) => logs.push(l) };
  const phones = await resolveNudgeRecipients(sb, "ctr-1", opts.isTest, gate);
  const results = [];
  for (const phone of phones) {
    results.push(await attemptContractorSms(fetchImpl, "https://proj.supabase.co", "service-role-key", phone, "hello contractor", "ctr-1", opts.isTest, gate));
  }
  return { phones, results, calls, logs, rpcCalls };
}

Deno.test("NEGATIVE CONTROL: sms_opt_in + a phone on file but NO verified number -> no send-sms call, refusal logged as unverified_number", async () => {
  // The contractor row is deliberately not consulted: resolveNudgeRecipients takes no phone or opt-in input at all.
  const r = await nudge({ verified: [], isTest: true });
  assertEquals(r.phones, []);
  assertEquals(r.calls.length, 0);
  assertEquals(r.rpcCalls.length, 1);
  assertEquals(r.rpcCalls[0].fn, "contractor_textable_numbers");
  assertEquals(r.rpcCalls[0].args, { p_contractor_id: "ctr-1" });
  assertEquals(r.logs.length, 1);
  assert(r.logs[0].includes('"event":"contractor_sms_refused"'));
  assert(r.logs[0].includes('"reason":"unverified_number"'));
  assert(r.logs[0].includes('"contractor_id":"ctr-1"'));
  assert(r.logs[0].includes("send-contractor-nudge/consent-gate"));
});

Deno.test("a VERIFIED number on an is_test contractor IS texted, via the service-role bearer, to exactly that number", async () => {
  const r = await nudge({ verified: [V1], isTest: true });
  assertEquals(r.phones, ["+15155550142"]);
  assertEquals(r.results, [{ attempted: true, ok: true }]);
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0].url, "https://proj.supabase.co/functions/v1/send-sms");
  assertEquals(r.calls[0].init.method, "POST");
  assertEquals((r.calls[0].init.headers as Record<string, string>).Authorization, "Bearer service-role-key");
  assertEquals(JSON.parse(r.calls[0].init.body as string), { to: "+15155550142", message: "hello contractor" });
});

Deno.test("every verified number is texted, primary first, and nothing else", async () => {
  const two = [V1, { number_id: "n2", phone_e164: "+15155550143", is_primary: false }];
  const r = await nudge({ verified: two, isTest: true });
  assertEquals(r.calls.map((c) => JSON.parse(c.init.body as string).to), ["+15155550142", "+15155550143"]);
});

Deno.test("a lookup error fails closed: no send-sms call, refusal logged", async () => {
  const r = await nudge({ verified: [V1], isTest: true, rpcError: true });
  assertEquals(r.phones, []);
  assertEquals(r.calls.length, 0);
  assert(r.logs.some((l) => l.includes('"reason":"unverified_number"') && l.includes('"detail":"lookup_failed"')));
});

Deno.test("malformed rows (not E.164) are dropped: no send", async () => {
  const r = await nudge({ verified: [{ number_id: "n1", phone_e164: "515-555-0142", is_primary: true }], isTest: true });
  assertEquals(r.calls.length, 0);
});

Deno.test("the verified-recipient log line carries the consent record (verified_at + disclosure version), number masked", async () => {
  const { sb } = fakeClient([V1]);
  const info: string[] = [];
  const out = await resolveContractorTextableNumbers(sb, "ctr-1", { site: "t", info: (l) => info.push(l) });
  assertEquals(out[0].consent, { verified_at: "2026-10-01T00:00:00Z", disclosure_version_id: "v-test" });
  assertEquals(info.length, 1);
  assert(info[0].includes('"verified_at":"2026-10-01T00:00:00Z"'));
  assert(info[0].includes('"disclosure_version_id":"v-test"'));
  assert(info[0].includes("***0142"));
  assertEquals(info[0].includes("5155550142"), false, "full number must never be logged");
});

// -- D-391 / #2875: TCR release gate stays IN FRONT of the lookup (is_test-only until CONTRACTOR_SMS_TCR_RELEASED === "true") --

Deno.test("gh-2875: verified number on a NON-test contractor, switch unset -> no lookup, no send, tcr_not_released logged", async () => {
  const r = await nudge({ verified: [V1], isTest: false });
  assertEquals(r.phones, []);
  assertEquals(r.rpcCalls.length, 0, "the release gate must refuse before any lookup");
  assertEquals(r.calls.length, 0);
  assertEquals(r.logs.length, 1);
  assert(r.logs[0].includes('"reason":"tcr_not_released"'));
});

Deno.test("gh-2875: is_test null / undefined (unreadable) fails closed", async () => {
  for (const v of [null, undefined]) {
    const r = await nudge({ verified: [V1], isTest: v });
    assertEquals(r.calls.length, 0);
  }
});

Deno.test("gh-2875: switch values other than the exact string 'true' do not release", async () => {
  for (const v of ["", "1", "TRUE", "yes", "false"]) {
    const r = await nudge({ verified: [V1], isTest: false, released: v });
    assertEquals(r.calls.length, 0, `released=${JSON.stringify(v)}`);
  }
});

Deno.test("gh-2875: switch 'true' releases a verified number on a non-test contractor", async () => {
  const r = await nudge({ verified: [V1], isTest: false, released: "true" });
  assertEquals(r.calls.length, 1);
});

Deno.test("gh-2875: the release switch never creates a recipient: released + no verified number -> still no send", async () => {
  const r = await nudge({ verified: [], isTest: false, released: "true" });
  assertEquals(r.calls.length, 0);
  assert(r.logs.some((l) => l.includes('"reason":"unverified_number"')));
});

Deno.test("attemptContractorSms: send-sms itself failing is reported (attempted true, ok false)", async () => {
  const { fetchImpl, calls } = makeFetchSpy(false);
  const result = await attemptContractorSms(fetchImpl, "https://proj.supabase.co", "k", "+15155550142", "hello", "ctr-1", true);
  assertEquals(result, { attempted: true, ok: false });
  assertEquals(calls.length, 1);
});

Deno.test("attemptContractorSms: a non-test contractor is refused at the send itself too (belt and braces)", async () => {
  const { fetchImpl, calls } = makeFetchSpy(true);
  const result = await attemptContractorSms(fetchImpl, "https://proj.supabase.co", "k", "+15155550142", "hello", "ctr-1", false, { getEnv: envOf(undefined), log: () => {} });
  assertEquals(result, { attempted: false, ok: false });
  assertEquals(calls.length, 0);
});
