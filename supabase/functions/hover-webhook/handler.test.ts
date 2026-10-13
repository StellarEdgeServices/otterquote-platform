// gh-1873: hover-webhook is disabled. These tests fail against the old implementation (which read HOVER_* secrets from
// Deno.env, called the Hover API and the database, and answered with its own payloads; negative control: run them
// against main 4f331d4's index.ts and every behavioural test fails).
// Run: deno test --allow-read=supabase/functions supabase/functions/hover-webhook/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { DISABLED_BODY, handle } from "./handler.ts";

const URL_ = "https://example.test/functions/v1/hover-webhook";
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

Deno.test("gh-1873 a webhook POST (signed or not) answers 410 Gone with the disabled body, and no network call is made", async () => {
  const { result, calls } = await withNetworkTrap(() => Promise.resolve(handle(post({ job_id: 123, event: "job.completed" }, { "X-Hover-Signature": "sha256=abc" }))));
  assertEquals(result.status, 410);
  assertEquals(await result.json(), DISABLED_BODY);
  assertEquals(calls, 0);
});

Deno.test("gh-1873 every method and an empty or malformed body answer 410, never an error", async () => {
  for (const raw of ["not json", "", "null"]) {
    const res = handle(post(raw));
    assertEquals(res.status, 410);
    assertEquals((await res.json()).disabled, true);
  }
  for (const method of ["GET", "OPTIONS", "PUT"]) {
    const res = handle(new Request(URL_, { method }));
    assertEquals(res.status, 410);
    await res.text();
  }
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
