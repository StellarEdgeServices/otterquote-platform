// Deno unit tests for ref-redirect.ts (gh-1738).
// Run: deno test netlify/edge-functions/ref-redirect.test.ts
//
// gh-1738: netlify/edge-functions/*.ts had ZERO automated coverage -- neither
// CI check whose name begins "Edge Function..." actually exercises this
// directory (both were scoped to supabase/functions/). This is the first
// real test this file has ever had. No network, no secrets -- pure-unit,
// same convention as supabase/functions/**/*.test.ts (gh-422).

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "./ref-redirect.ts";

// Minimal fake Netlify Edge Function context. Real `context.next()` hands
// the request to Netlify's normal static pipeline; here it just needs to be
// observably distinguishable from the redirect path so a test can assert
// which branch fired.
function fakeContext() {
  let nextCalled = false;
  return {
    next: async () => {
      nextCalled = true;
      return new Response("next-called", { status: 200 });
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

Deno.test("ref-redirect: /ref/<code> 301s to /ref.html?code=<code>", async () => {
  const req = new Request("https://otterquote.com/ref/ABC123");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 301);
  assertEquals(res.headers.get("location"), "https://otterquote.com/ref.html?code=ABC123");
  assertEquals(ctx.nextCalled, false);
});

Deno.test("ref-redirect: forwards incoming query params (utm_source) and still sets code", async () => {
  const req = new Request("https://otterquote.com/ref/XYZ789?utm_source=partner&utm_medium=email");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  const location = new URL(res.headers.get("location")!);
  assertEquals(res.status, 301);
  assertEquals(location.pathname, "/ref.html");
  assertEquals(location.searchParams.get("utm_source"), "partner");
  assertEquals(location.searchParams.get("utm_medium"), "email");
  assertEquals(location.searchParams.get("code"), "XYZ789");
});

Deno.test("ref-redirect: a stray ?code= on the short link is overridden by the path segment", async () => {
  const req = new Request("https://otterquote.com/ref/REAL?code=FAKE");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  const location = new URL(res.headers.get("location")!);
  assertEquals(location.searchParams.get("code"), "REAL");
});

Deno.test("ref-redirect: a path outside /ref/<code> falls through via context.next()", async () => {
  const req = new Request("https://otterquote.com/ref/");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
  assertEquals(await res.text(), "next-called");
});
