// gh-1873: create-hover-order is disabled. These tests fail against the old implementation (which read HOVER_* secrets from
// Deno.env, called the Hover API and the database, and answered with its own payloads; negative control: run them
// against main 4f331d4's index.ts and every behavioural test fails).
// Run: deno test --allow-read=supabase/functions supabase/functions/create-hover-order/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { DISABLED_BODY, handle } from "./handler.ts";

const URL_ = "https://example.test/functions/v1/create-hover-order";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function withNetworkTrap<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.reject(new Error("network must not be touched")); }) as typeof fetch;
  return fn().then((result) => ({ result, calls })).finally(() => { globalThis.fetch = realFetch; });
}

Deno.test("gh-1873 a realistic caller payload answers 200 disabled, and no network call is made", async () => {
  const { result, calls } = await withNetworkTrap(() => handle(post({ claim_id: "c1", order_id: "o1", payment_intent_id: "pi_test_123", format: "url" }, { Authorization: "Bearer x" })));
  assertEquals(result.status, 200);
  assertEquals(await result.json(), DISABLED_BODY);
  assertEquals(calls, 0);
});

Deno.test("gh-1873 a service-role (cron) style call is answered the same way and is not authenticated against anything", async () => {
  const { result, calls } = await withNetworkTrap(() => handle(post({}, { Authorization: "Bearer not-a-real-key" })));
  assertEquals(result.status, 200);
  assertEquals((await result.json()).reason, "hover_disabled");
  assertEquals(calls, 0);
});

Deno.test("gh-1873 malformed or empty body is a clean 200, never an error", async () => {
  for (const raw of ["not json", "", "null"]) {
    const res = await handle(post(raw));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).disabled, true);
  }
});

Deno.test("gh-1873 health_check still answers ok (pingers stay green)", async () => {
  const res = await handle(post({ health_check: true }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
});

Deno.test("gh-1873 CORS preflight and method guard", async () => {
  const pre = await handle(new Request(URL_, { method: "OPTIONS", headers: { Origin: "https://otterquote.com" } }));
  assertEquals(pre.status, 200);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
  await pre.text();
  const get = await handle(new Request(URL_, { method: "GET" }));
  assertEquals(get.status, 405);
  await get.text();
});

/** Code lines only: comments may still name the vendor. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

const FORBIDDEN = /Deno\.env|HOVER_[A-Z_]+|hover\.to|fetch\(|createClient|supabase-js|Authorization/;

for (const file of ["./handler.ts", "./index.ts"]) {
  Deno.test(`gh-1873 ${file} reads no secret and makes no outbound call`, async () => {
    const code = codeOnly(await Deno.readTextFile(new URL(file, import.meta.url)));
    assertEquals(FORBIDDEN.exec(code), null);
  });
}

Deno.test("gh-1873 the source scan itself can fail (negative control)", () => {
  assert(FORBIDDEN.test(codeOnly('const t = Deno.env.get("HOVER_CLIENT_SECRET");')));
  assert(FORBIDDEN.test(codeOnly('await fetch("https://hover.to/api/v2/jobs")')));
  assert(!FORBIDDEN.test(codeOnly("// Deno.env.get(HOVER_CLIENT_ID) is only named in a comment")));
});
