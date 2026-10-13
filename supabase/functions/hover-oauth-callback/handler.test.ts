// gh-1873: hover-oauth-callback is disabled. These tests fail against the old implementation (which read HOVER_* secrets from
// Deno.env, called the Hover API and the database, and answered with its own payloads; negative control: run them
// against main 4f331d4's index.ts and every behavioural test fails).
// Run: deno test --allow-read=supabase/functions supabase/functions/hover-oauth-callback/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { GONE_TEXT, handle } from "./handler.ts";

const URL_ = "https://example.test/functions/v1/hover-oauth-callback";

function withNetworkTrap<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.reject(new Error("network must not be touched")); }) as typeof fetch;
  return fn().then((result) => ({ result, calls })).finally(() => { globalThis.fetch = realFetch; });
}

Deno.test("gh-1873 a browser landing with an OAuth code answers 410 and the plain-text message", async () => {
  const { result, calls } = await withNetworkTrap(() => Promise.resolve(handle(new Request(URL_ + "?code=abc&state=xyz", { method: "GET" }))));
  assertEquals(result.status, 410);
  assertEquals(result.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assertEquals(await result.text(), GONE_TEXT);
  assertEquals(calls, 0);
});

Deno.test("gh-1873 POST, OPTIONS and HEAD-style requests also answer 410", async () => {
  for (const method of ["POST", "OPTIONS", "PUT"]) {
    const res = handle(new Request(URL_, { method, body: method === "POST" || method === "PUT" ? "{}" : undefined }));
    assertEquals(res.status, 410);
    await res.text();
  }
});

Deno.test("gh-1873 the message names no secret and no vendor token", () => {
  assert(!/secret|token|client_id/i.test(GONE_TEXT));
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
