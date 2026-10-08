// gh-2426: create-hubspot-contact is disabled. These tests fail against the old implementation
// (which called api.hubapi.com, read HUBSPOT_PRIVATE_APP_TOKEN and answered "token_not_configured").
// Run: deno test --allow-read=supabase/functions supabase/functions/create-hubspot-contact/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { DISABLED_BODY, handle } from "./handler.ts";

const URL_ = "https://example.test/functions/v1/create-hubspot-contact";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("gh-2426 homeowner payload -> 200 disabled, and no network call is made", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.reject(new Error("network must not be touched")); }) as typeof fetch;
  try {
    const res = await handle(post({ email: "a@b.com", firstname: "A", lastname: "B", phone: "1", address: "x" }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), DISABLED_BODY);
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("gh-2426 contractor payload -> 200 disabled, no network call", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.reject(new Error("network must not be touched")); }) as typeof fetch;
  try {
    const res = await handle(post({ mode: "contractor", email: "c@d.com", contractor_id: "abc" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).disabled, true);
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("gh-2426 bootstrap mode is not reachable (no HubSpot property PATCH)", async () => {
  const res = await handle(post({ mode: "bootstrap", bootstrap_key: "anything" }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).reason, "hubspot_disabled");
});

Deno.test("gh-2426 malformed or empty body is a clean 200, never an error", async () => {
  for (const raw of ["not json", "", "null"]) {
    const res = await handle(post(raw));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).disabled, true);
  }
});

Deno.test("gh-2426 health_check still answers ok (pingers stay green)", async () => {
  const res = await handle(post({ health_check: true }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
});

Deno.test("gh-2426 CORS preflight and method guard unchanged", async () => {
  const pre = await handle(new Request(URL_, { method: "OPTIONS", headers: { Origin: "https://otterquote.com" } }));
  assertEquals(pre.status, 200);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
  await pre.text();
  const get = await handle(new Request(URL_, { method: "GET" }));
  assertEquals(get.status, 405);
  await get.text();
});

Deno.test("gh-2426 handler source never references HubSpot's API or the token", async () => {
  const src = await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/**")).join("\n");
  assert(!/hubapi\.com/.test(code));
  assert(!/HUBSPOT_PRIVATE_APP_TOKEN/.test(code));
  assert(!/fetch\(/.test(code));
});
