// gh-2884: RUNTIME companion to sms-all-bodies.test.ts. Drives the REAL exported handler from index.ts with
// globalThis.fetch and Deno.env stubbed, collects every request that reaches api.twilio.com, and asserts each
// Twilio "Body" begins "Otter Quotes" (D-175). No regex over source: whatever the code actually sends is checked,
// so it also covers transports/aliases/split URLs that a text scan can miss.
// Paths driven: CRON hourly reminder, CRON 8 AM warning, HOMEOWNER choice=proceed, HOMEOWNER choice=different.
// The TRIGGER immediate send passes the same HOURLY_SMS constant as CRON hourly and depends on wall-clock
// quiet hours, so it is covered by the static test only.
// Test-only. Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-runtime-bodies.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handler } from "./index.ts";

const BRAND = "Otter Quotes";
const KEY = "fixture-runtime-service-key-0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const FAIL_ID = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: KEY,
  TWILIO_ACCOUNT_SID: "ACfixture",
  TWILIO_AUTH_TOKEN: "fixture-token",
  TWILIO_MESSAGING_SERVICE_SID: "MGfixture",
  MAILGUN_API_KEY: "fixture-mailgun",
};

const contractor = {
  id: "c1", company_name: "Fixture Roofing", email: "c@example.com", notification_emails: [],
  notification_phones: ["317-555-0101", "317-555-0102"], user_id: null, timezone: "America/New_York",
  address_state: "IN", sms_opt_in: true,
};
const claim = { id: "cl1", property_address: "1 Main St", status: "payment_failed" };
function failure(over: Record<string, unknown>) {
  return {
    id: FAIL_ID, quote_id: "q1234567", contractor_id: "c1", claim_id: "cl1", homeowner_id: "h1",
    amount_cents: 12345, reminder_count: 0, contractor_timezone: "America/New_York",
    dunning_status: "warning_sent", contractors: contractor, claims: claim, ...over,
  };
}

/** Run `fn` with fetch + Deno.env stubbed; returns every Twilio Body that was sent. */
async function twilioBodies(fn: () => Promise<Response>, activeRows: unknown[], singleRow: unknown): Promise<{ bodies: string[]; res: Response }> {
  const realFetch = globalThis.fetch;
  const realEnv = Deno.env;
  const bodies: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.twilio.com") {
      bodies.push(new URLSearchParams(await req.text()).get("Body") ?? "");
      return json({ sid: "SMfixture" });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const single = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
      const table = url.pathname.split("/").pop();
      if (req.method === "GET" && table === "payment_failures") {
        if (single) return json(singleRow);
        return json(url.searchParams.get("dunning_status") === "eq.active" ? activeRows : []);
      }
      return json(single ? { id: "x" } : req.method === "GET" ? [] : [{ id: "x" }]);
    }
    return json({});
  }) as typeof fetch;
  Object.defineProperty(Deno, "env", { value: { get: (n: string) => ENV[n] }, configurable: true });
  try {
    return { bodies, res: await fn() };
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, "env", { value: realEnv, configurable: true });
  }
}

export function unbranded(bodies: string[]): string[] {
  return bodies.filter((b) => !b.startsWith(BRAND));
}

Deno.test("runtime control: the unbranded filter flags an unbranded Body and passes a branded one", () => {
  assertEquals(unbranded(["Otter Quotes: hi"]), []);
  assertEquals(unbranded(["Otter Quotes: hi", "Your card failed, pay now"]), ["Your card failed, pay now"]);
  assertEquals(unbranded([""]), [""]);
});

Deno.test("runtime: CRON hourly reminder and 8 AM warning send only Twilio Bodies that begin 'Otter Quotes'", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 6 * 3600_000).toISOString();
  const rows = [
    failure({ id: "f-warning", dunning_status: "active", warning_at: past, next_reminder_at: past }),
    failure({ id: "f-hourly", dunning_status: "active", warning_at: future, next_reminder_at: past }),
  ];
  const { bodies, res } = await twilioBodies(
    () => handler(new Request(BASE, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }), (n) => ENV[n]),
    rows, null,
  );
  assertEquals(res.status, 200);
  // 2 phones x (1 warning + 1 hourly)
  assertEquals(bodies.length, 4, `expected 4 Twilio sends, got ${bodies.length}`);
  assert(bodies.some((b) => b.includes("10 a.m. today")), "warning body not observed");
  assert(bodies.some((b) => b.includes("resolve the matter")), "hourly body not observed");
  assertEquals(unbranded(bodies), []);
});

for (const choice of ["proceed", "different"]) {
  Deno.test(`runtime: HOMEOWNER choice=${choice} sends only Twilio Bodies that begin 'Otter Quotes'`, async () => {
    const { bodies, res } = await twilioBodies(
      () => handler(new Request(`${BASE}?mode=homeowner_choice&failure_id=${FAIL_ID}&choice=${choice}`, { method: "GET" }), (n) => ENV[n]),
      [], failure({}),
    );
    assertEquals(res.status, 200);
    assertEquals(bodies.length, 2, `expected 2 Twilio sends (one per phone), got ${bodies.length}`);
    assertEquals(unbranded(bodies), []);
  });
}
