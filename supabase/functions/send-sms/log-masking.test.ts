// gh-3773 (SMS hardening follow-up to the #3772 review, item 1): no send-sms log line contains a full phone number.
// Drives the REAL exported send-sms handler with the Supabase REST layer, Twilio and Deno.env stubbed (no network, no SMS),
// captures every console line, and asserts no full number appears in any of them, for a successful send and for a Twilio error.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/log-masking.test.ts
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { maskPhone, maskPhoneNumbersInText } from "../_shared/sms-log-mask.ts";
import { handler } from "./index.ts";

// 22:00Z on a Monday = 17:00 ET / 12:00 HST: inside the 08:00-20:00 window in every US zone, so quiet hours never refuse.
const NOW = new Date("2026-11-16T22:00:00Z").getTime();
{
  const RealDate = Date;
  // deno-lint-ignore no-explicit-any
  class ClockDate extends RealDate { constructor(...a: any[]) { if (a.length === 0) super(NOW); else super(...(a as [number])); } static override now() { return NOW; } }
  globalThis.Date = ClockDate as unknown as DateConstructor;
}

const KEY = "fixture-send-sms-service-key-0123456789";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, TWILIO_ACCOUNT_SID: "ACfixture",
  TWILIO_AUTH_TOKEN: "fixture-token", TWILIO_PHONE_NUMBER: "+18448753412",
};
const TO = "+13175551234";
const FULL_FORMS = ["13175551234", "3175551234", "317-555-1234", "(317) 555-1234", "8448753412"]; // recipient and the sender number, every spelling

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

interface Run { status: number; body: string; logs: string[]; twilioCalls: number }
async function run(twilio: () => Response): Promise<Run> {
  const logs: string[] = [];
  const realFetch = globalThis.fetch, realEnv = Deno.env, rw = console.warn, rl = console.log, re = console.error;
  const cap = (...a: unknown[]) => { logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  console.warn = cap; console.log = cap; console.error = cap;
  let twilioCalls = 0;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.twilio.com") { twilioCalls++; return twilio(); }
    if (url.pathname.startsWith("/rest/v1/rpc/check_rate_limit")) return json({ allowed: true, counts: {} });
    if (url.pathname.startsWith("/rest/v1/")) return json(req.method === "GET" ? [] : [{ id: "x" }]);
    return json({});
  }) as typeof fetch;
  Object.defineProperty(Deno, "env", { value: { get: (n: string) => ENV[n] }, configurable: true });
  try {
    const res = await handler(new Request("https://x.supabase.co/functions/v1/send-sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: TO, message: "fixture body" }),
    }));
    return { status: res.status, body: await res.text(), logs, twilioCalls };
  } finally {
    globalThis.fetch = realFetch; Object.defineProperty(Deno, "env", { value: realEnv, configurable: true });
    console.warn = rw; console.log = rl; console.error = re;
  }
}
const leaks = (lines: string[]) => lines.filter((l) => FULL_FORMS.some((f) => l.includes(f)) || /\+?\d{7,}/.test(l.replace(/AC[0-9a-z]+|SM[0-9a-z]+/gi, "")));

Deno.test("NEGATIVE CONTROL success: the 'Sending SMS' line names the number by last 4 only; no log line holds a full number", async () => {
  const r = await run(() => json({ sid: "SMfixture", to: TO, status: "queued" }, 201));
  assertEquals(r.status, 200);
  assertEquals(r.twilioCalls, 1);
  const sending = r.logs.filter((l) => l.startsWith("Sending SMS"));
  assertEquals(sending.length, 1);
  assert(sending[0].includes("***1234"), `expected the masked last 4, got: ${sending[0]}`);
  assertEquals(leaks(r.logs), [], `full number in a log line: ${JSON.stringify(leaks(r.logs))}`);
});

Deno.test("NEGATIVE CONTROL Twilio error: Twilio's error body names the To number; the log lines AND the 500 body carry the last 4 only", async () => {
  const twilioBody = JSON.stringify({ code: 21211, message: `The 'To' number ${TO} is not a valid phone number.`, more_info: "https://www.twilio.com/docs/errors/21211", status: 400 });
  const r = await run(() => new Response(twilioBody, { status: 400 }));
  assertEquals(r.status, 500);
  assertEquals(r.twilioCalls, 1);
  assert(r.logs.some((l) => l.startsWith("Twilio SMS send failed:") && l.includes("400") && l.includes("21211")), "the failure is still logged with status and Twilio's error code");
  assert(r.logs.some((l) => l.startsWith("send-sms error:")), "the catch still logs");
  assertEquals(leaks(r.logs), [], `full number in a log line: ${JSON.stringify(leaks(r.logs))}`);
  assertFalse(r.body.includes("5551234") && r.body.includes("317"), "the number is not echoed to the caller either");
  assert(r.body.includes("***1234"));
});

Deno.test("maskPhoneNumbersInText: E.164, dashed, parenthesised and bare 10/11-digit forms are masked; 5-digit error codes, dates and SIDs are not", () => {
  assertEquals(maskPhoneNumbersInText("to +13175551234 failed"), "to ***1234 failed");
  assertEquals(maskPhoneNumbersInText("(317) 555-1234 and 317-555-9999 and 3175550000"), "***1234 and ***9999 and ***0000");
  assertEquals(maskPhoneNumbersInText('{"code":21211,"status":400}'), '{"code":21211,"status":400}');
  assertEquals(maskPhoneNumbersInText("2026-11-16 SMfixture0123"), "2026-11-16 SMfixture0123");
  assertEquals(maskPhoneNumbersInText(null), "");
  assertEquals(maskPhone("+13175551234"), "***1234");
  assertEquals(maskPhone("12"), "***????");
});
