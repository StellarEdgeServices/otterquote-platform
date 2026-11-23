// Deno unit tests for send-contractor-nudge's owner-alert e-mail fallback (gh-3849).
// Run: deno test supabase/functions/send-contractor-nudge/owner-alert.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { OWNER_ALERT_EMAIL, sendOwnerAlertSms } from "./owner-alert.ts";

const ENV = { supabaseUrl: "https://x.supabase.co", serviceRoleKey: "srk", mailgunKey: "mgk", mailgunDomain: "mg.example.test" };
const IDS = { claimId: "claim-1", contractorId: "con-1" };

/** smsMode: status code, or "throw". emailMode: status code, or "throw". */
function spy(smsMode: number | "throw", emailMode: number | "throw" = 200) {
  const sms: string[] = [];
  const emails: { url: string; body: FormData }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    if (url.includes("/functions/v1/send-sms")) {
      sms.push(url);
      if (smsMode === "throw") return Promise.reject(new Error("net down"));
      return Promise.resolve(new Response("x", { status: smsMode }));
    }
    emails.push({ url, body: init.body as FormData });
    if (emailMode === "throw") return Promise.reject(new Error("mailgun down"));
    return Promise.resolve(new Response("{}", { status: emailMode }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sms, emails };
}

Deno.test("SMS non-2xx -> exactly one e-mail to the owner address", async () => {
  const s = spy(500);
  const r = await sendOwnerAlertSms(s.fetchImpl, ENV, "+15555550100", "m", IDS);
  assertEquals(s.sms.length, 1);
  assertEquals(s.emails.length, 1);
  assertEquals(s.emails[0].body.get("to"), OWNER_ALERT_EMAIL);
  const text = String(s.emails[0].body.get("text"));
  assert(text.includes("HTTP 500") && text.includes("claim-1") && text.includes("con-1"));
  assert(!text.includes("+15555550100"));
  assertEquals(r, { smsOk: false, emailAttempted: true, emailOk: true });
});

Deno.test("SMS throws -> exactly one e-mail", async () => {
  const s = spy("throw");
  await sendOwnerAlertSms(s.fetchImpl, ENV, "+15555550100", "m", IDS);
  assertEquals(s.emails.length, 1);
});

Deno.test("SMS 2xx -> zero e-mail calls", async () => {
  const s = spy(200);
  const r = await sendOwnerAlertSms(s.fetchImpl, ENV, "+15555550100", "m", IDS);
  assertEquals(s.emails.length, 0);
  assertEquals(r.smsOk, true);
});

Deno.test("e-mail failure (non-2xx or throw) is handled, no throw", async () => {
  for (const mode of [500, "throw"] as const) {
    const s = spy(500, mode);
    const r = await sendOwnerAlertSms(s.fetchImpl, ENV, "+15555550100", "m", IDS);
    assertEquals(s.emails.length, 1);
    assertEquals(r, { smsOk: false, emailAttempted: true, emailOk: false });
  }
});

Deno.test("missing Mailgun env -> no e-mail call, handled", async () => {
  const s = spy(500);
  const r = await sendOwnerAlertSms(s.fetchImpl, { ...ENV, mailgunKey: "" }, "+15555550100", "m", IDS);
  assertEquals(s.emails.length, 0);
  assertEquals(r.emailOk, false);
});
