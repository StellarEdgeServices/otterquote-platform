// Deno unit tests for recruit-redirect.ts (gh-1738).
// Run: deno test netlify/edge-functions-tests/recruit-redirect.test.ts
//
// gh-1738 note: lives in netlify/edge-functions-tests/, a SIBLING of
// netlify/edge-functions/ -- see admin-auth-gate.test.ts for why (Netlify
// auto-discovers every .ts directly under netlify/edge-functions/ as a
// deployable candidate; a test file there broke the deploy preview build).
//
// gh-1738: this file (the highest-value entry point on the site, per its own
// header comment) had zero automated coverage before this test existed.
// Pure-unit -- no network, no secrets.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "../edge-functions/recruit-redirect.ts";

// Captures what the handler asked Netlify to rewrite to, without needing a
// real Netlify runtime. context.rewrite() serves the target's content as a
// 200 while leaving the browser's URL bar untouched -- this fake just
// records the URL it was called with and returns a recognizable body so a
// test can assert the rewrite branch (not the fail-open next() branch) fired.
function fakeContext(opts: { rewriteThrows?: boolean } = {}) {
  let rewriteCalledWith: URL | null = null;
  let nextCalled = false;
  return {
    rewrite: async (target: URL) => {
      if (opts.rewriteThrows) throw new Error("simulated edge runtime failure");
      rewriteCalledWith = target;
      return new Response("rewritten", { status: 200 });
    },
    next: async () => {
      nextCalled = true;
      return new Response("next-called", { status: 200 });
    },
    get rewriteCalledWith() {
      return rewriteCalledWith;
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

Deno.test("recruit-redirect: /recruit/ rewrites (200, no redirect) to /recruit.html", async () => {
  const req = new Request("https://otterquote.com/recruit/");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(await res.text(), "rewritten");
  assertEquals(ctx.rewriteCalledWith?.pathname, "/recruit.html");
  assertEquals(ctx.nextCalled, false);
});

Deno.test("recruit-redirect: /Recruit.html rewrites to /recruit.html and preserves ?code=", async () => {
  const req = new Request("https://otterquote.com/Recruit.html?code=PARTNER1");
  const ctx = fakeContext();
  await handler(req, ctx);

  assertStringIncludes(ctx.rewriteCalledWith!.toString(), "/recruit.html");
  assertEquals(ctx.rewriteCalledWith?.searchParams.get("code"), "PARTNER1");
});

Deno.test("recruit-redirect: fail-open -- a throw from context.rewrite() falls through via context.next(), never a 500", async () => {
  const req = new Request("https://otterquote.com/recruit/");
  const ctx = fakeContext({ rewriteThrows: true });
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
  assertEquals(await res.text(), "next-called");
});
