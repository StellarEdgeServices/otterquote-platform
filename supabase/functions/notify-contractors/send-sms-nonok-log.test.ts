// gh-3773 (SMS hardening follow-up to the #3772 review, item 2): the new_opportunity loop used to skip a 403 / 503 from send-sms
// with NO log line (only 429 was logged). Every non-2xx is now logged with the status code and the last 4 digits.
// Drives the REAL exported handler (service caller, event new_opportunity) with a fake supabase client and a send-sms stub.
// Run: deno test --allow-read=supabase/functions supabase/functions/notify-contractors/send-sms-nonok-log.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, SERVICE_KEY } from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const PHONE = "+13175551234";
const CONTRACTOR = { id: "c1", user_id: "u1", email: null, contact_name: "Fixture", notification_emails: [], notification_preferences: null, trades: ["roofing"], service_counties: [], is_test: true, status: "active" };

// deno-lint-ignore no-explicit-any
function fakeClient(): any {
  const rows: Record<string, unknown[]> = { claims: [{ is_test: true }], contractors: [CONTRACTOR], notifications: [] };
  const builder = (table: string): unknown => new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res);
      if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
      return () => builder(table);
    },
  });
  return {
    from: (t: string) => builder(t),
    rpc: (n: string) => Promise.resolve(
      n === "check_rate_limit" ? { data: { allowed: true }, error: null }
      : n === "contractor_textable_numbers" ? { data: [{ number_id: "n1", phone_e164: PHONE, is_primary: true }], error: null }
      : { data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: "n/a" } }) },
  };
}

async function runWith(sendSmsStatus: number): Promise<{ logs: string[]; sendSmsCalls: number; smsSent: unknown }> {
  const logs: string[] = [];
  const realFetch = globalThis.fetch, rw = console.warn, rl = console.log, re = console.error;
  const cap = (...a: unknown[]) => { logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  console.warn = cap; console.log = cap; console.error = cap;
  let sendSmsCalls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith("/functions/v1/send-sms")) {
      sendSmsCalls++;
      return Promise.resolve(new Response(JSON.stringify(sendSmsStatus === 200 ? { sid: "SMfixture" } : { error: "refused" }), { status: sendSmsStatus, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "stub" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/notify-contractors", {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "new_opportunity", claim_id: "cl1", claim_city: "Carmel", claim_state: "IN", claim_zip: "46032", trade_types: ["roofing"] }),
      }),
      (n) => BASE_ENV[n],
      (() => fakeClient()) as never,
    );
    assertEquals(res.status, 200, "the handler itself still answers 200");
    const out = await res.json();
    return { logs, sendSmsCalls, smsSent: JSON.stringify(out) };
  } finally {
    globalThis.fetch = realFetch; console.warn = rw; console.log = rl; console.error = re;
  }
}
const nonOk = (logs: string[], code: number) => logs.filter((l) => l.includes("send-sms refused") && l.includes(`HTTP ${code}`));

Deno.test("NEGATIVE CONTROL 403: a refused send (paused / suppressed / quiet hours) produces a log line with the status and the last 4 digits", async () => {
  const r = await runWith(403);
  assertEquals(r.sendSmsCalls, 1, "the loop did call send-sms");
  const lines = nonOk(r.logs, 403);
  assertEquals(lines.length, 1, `expected one non-2xx line, logs: ${JSON.stringify(r.logs)}`);
  assert(lines[0].includes("to_last4=1234") && lines[0].includes("c1"), lines[0]);
  assert(!r.logs.some((l) => l.includes(PHONE) || l.includes("3175551234")), "no full number in any log line");
});

Deno.test("NEGATIVE CONTROL 503: a fail-closed lookup (send-sms 503) produces a log line with the status and the last 4 digits", async () => {
  const r = await runWith(503);
  const lines = nonOk(r.logs, 503);
  assertEquals(lines.length, 1, `expected one non-2xx line, logs: ${JSON.stringify(r.logs)}`);
  assert(lines[0].includes("to_last4=1234"), lines[0]);
});

Deno.test("a 2xx from send-sms logs no refusal line and the SMS is counted as sent", async () => {
  const r = await runWith(200);
  assertEquals(r.logs.filter((l) => l.includes("send-sms refused")).length, 0);
  assert(String(r.smsSent).includes('"sms_sent":true'));
});
