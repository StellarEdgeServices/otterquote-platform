// Deno unit tests for ref-redirect.ts (gh-1738).
// Run: deno test netlify/edge-functions-tests/ref-redirect.test.ts
//
// gh-1738 note: lives in netlify/edge-functions-tests/, a SIBLING of
// netlify/edge-functions/ -- see admin-auth-gate.test.ts for why (Netlify
// auto-discovers every .ts directly under netlify/edge-functions/ as a
// deployable candidate; a test file there broke the deploy preview build).
//
// gh-1738: netlify/edge-functions/*.ts had ZERO automated coverage -- neither
// CI check whose name begins "Edge Function..." actually exercises this
// directory (both were scoped to supabase/functions/). This is the first
// real test this file has ever had. No network, no secrets -- pure-unit,
// same convention as supabase/functions/**/*.test.ts (gh-422).

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler, { PARTNER_COOKIE_MAX_AGE } from "../edge-functions/ref-redirect.ts";

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

// ---------------------------------------------------------------------------
// P18: server-set partner cookie `oq_pc` (survives Safari's 7-day script-cookie cap)
// ---------------------------------------------------------------------------

function parseSetCookie(res: Response): { name: string; value: string; attrs: string[] } | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const parts = raw.split(";").map((p) => p.trim());
  const eq = parts[0].indexOf("=");
  return { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), attrs: parts.slice(1) };
}

Deno.test("ref-redirect P18: /ref/<code> sets oq_pc with code + click time and the required attributes", async () => {
  const before = Date.now();
  const res = await handler(new Request("https://otterquote.com/ref/ABC123"), fakeContext());
  const after = Date.now();

  assertEquals(res.status, 301);
  assertEquals(res.headers.get("location"), "https://otterquote.com/ref.html?code=ABC123");

  const c = parseSetCookie(res);
  assert(c !== null, "Set-Cookie header present");
  assertEquals(c!.name, "oq_pc");
  assertEquals(c!.attrs.includes("Max-Age=7776000"), true);
  assertEquals(c!.attrs.includes("Domain=.otterquote.com"), true);
  assertEquals(c!.attrs.includes("Path=/"), true);
  assertEquals(c!.attrs.includes("Secure"), true);
  assertEquals(c!.attrs.includes("SameSite=Lax"), true);
  // Not HttpOnly on purpose: the browser readers fall back to this cookie.
  assertEquals(c!.attrs.some((a) => a.toLowerCase() === "httponly"), false);

  const payload = JSON.parse(decodeURIComponent(c!.value));
  assertEquals(payload.c, "ABC123");
  const t = Date.parse(payload.t);
  assert(Number.isFinite(t) && t >= before && t <= after, "t is the ISO click time");
  assertEquals(new Date(t).toISOString(), payload.t);
  // A cached 301 would skip the server on a repeat click and break last-click-wins.
  assertEquals(res.headers.get("cache-control"), "no-store");
});

Deno.test("ref-redirect P18: Max-Age is exactly 90 days", () => {
  assertEquals(PARTNER_COOKIE_MAX_AGE, 90 * 24 * 60 * 60);
  assertEquals(PARTNER_COOKIE_MAX_AGE, 7776000);
});

Deno.test("ref-redirect P18: a later click on another code overwrites oq_pc (last click wins)", async () => {
  const first = parseSetCookie(await handler(new Request("https://otterquote.com/ref/AAA111"), fakeContext()));
  const second = parseSetCookie(await handler(new Request("https://otterquote.com/ref/BBB222"), fakeContext()));
  // Same name + Domain + Path => the browser replaces the first cookie with the second.
  assertEquals(first!.name, second!.name);
  assertEquals(first!.attrs.filter((a) => /^(Domain|Path)=/.test(a)), second!.attrs.filter((a) => /^(Domain|Path)=/.test(a)));
  assertEquals(JSON.parse(decodeURIComponent(first!.value)).c, "AAA111");
  assertEquals(JSON.parse(decodeURIComponent(second!.value)).c, "BBB222");
});

Deno.test("ref-redirect P18: query params still forwarded alongside the cookie", async () => {
  const res = await handler(new Request("https://otterquote.com/ref/XYZ789?utm_source=ig"), fakeContext());
  assertEquals(res.headers.get("location"), "https://otterquote.com/ref.html?utm_source=ig&code=XYZ789");
  assertEquals(parseSetCookie(res)!.name, "oq_pc");
});

Deno.test("ref-redirect P18: a code that is not cookie-safe still redirects but sets no cookie", async () => {
  const res = await handler(new Request("https://otterquote.com/ref/a%3Bb%0D%0Ac"), fakeContext());
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("ref-redirect P18 negative control: a non-/ref path sets no cookie", async () => {
  for (const path of ["/pricing", "/ref/a/b", "/ref/"]) {
    const ctx = fakeContext();
    const res = await handler(new Request(`https://otterquote.com${path}`), ctx);
    assertEquals(ctx.nextCalled, true, `${path} falls through`);
    assertEquals(res.headers.get("set-cookie"), null, `${path} sets no cookie`);
  }
});
