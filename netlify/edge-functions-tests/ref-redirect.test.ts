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
import handler, { PARTNER_COOKIE_MAX_AGE, buildPartnerCookie } from "../edge-functions/ref-redirect.ts";

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

Deno.test("ref-redirect: /ref/<code> 302s to /ref.html?code=<code>", async () => {
  const req = new Request("https://otterquote.com/ref/ABC123");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "https://otterquote.com/ref.html?code=ABC123");
  assertEquals(ctx.nextCalled, false);
});

Deno.test("ref-redirect: forwards incoming query params (utm_source) and still sets code", async () => {
  const req = new Request("https://otterquote.com/ref/XYZ789?utm_source=partner&utm_medium=email");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  const location = new URL(res.headers.get("location")!);
  assertEquals(res.status, 302);
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

  assertEquals(res.status, 302);
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
  // A cached redirect would skip the server on a repeat click and break last-click-wins.
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
  assertEquals(res.status, 302);
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

// ---------------------------------------------------------------------------
// P18 REVIEW 6524205688: 302 (not a cacheable 301) and POST /ref-bind
// ---------------------------------------------------------------------------

const RID = "11111111-1111-4111-8111-111111111111";

function bind(opts: { rid?: string; code?: string; cookie?: string | null; method?: string; header?: boolean } = {}) {
  const u = new URL("https://otterquote.com/ref-bind");
  if (opts.rid !== undefined) u.searchParams.set("rid", opts.rid);
  u.searchParams.set("code", opts.code ?? "ABC123");
  const headers = new Headers();
  if (opts.header !== false) headers.set("x-oq-bind", "1");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return handler(new Request(u, { method: opts.method ?? "POST", headers }), fakeContext());
}

function pcCookieHeader(code: string, t: Date, extra: Record<string, unknown> = {}) {
  return "oq_pc=" + encodeURIComponent(JSON.stringify({ c: code, t: t.toISOString(), ...extra }));
}

Deno.test("ref-redirect P18: the redirect is a 302, never a cacheable 301", async () => {
  const res = await handler(new Request("https://otterquote.com/ref/ABC123"), fakeContext());
  assertEquals(res.status, 302);
});

Deno.test("ref-bind: re-issues oq_pc with the rid, the ORIGINAL click time and the REMAINING lifetime", async () => {
  const clicked = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const res = await bind({ rid: RID, cookie: pcCookieHeader("ABC123", clicked) });
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const c = parseSetCookie(res)!;
  assertEquals(c.name, "oq_pc");
  const payload = JSON.parse(decodeURIComponent(c.value));
  assertEquals(payload, { c: "ABC123", t: clicked.toISOString(), r: RID });
  for (const a of ["Domain=.otterquote.com", "Path=/", "Secure", "SameSite=Lax"]) assertEquals(c.attrs.includes(a), true, a);
  assertEquals(c.attrs.some((a) => a.toLowerCase() === "httponly"), false);
  const maxAge = Number(c.attrs.find((a) => a.startsWith("Max-Age="))!.split("=")[1]);
  assert(maxAge <= 80 * 24 * 3600 && maxAge > 80 * 24 * 3600 - 60, "Max-Age is the remaining ~80 days, not a fresh 90");
});

Deno.test("ref-bind: end to end - /ref/<code> then bind keeps the click time", async () => {
  const first = parseSetCookie(await handler(new Request("https://otterquote.com/ref/ABC123"), fakeContext()))!;
  const res = await bind({ rid: RID, cookie: `oq_pc=${first.value}` });
  const bound = JSON.parse(decodeURIComponent(parseSetCookie(res)!.value));
  assertEquals(bound.t, JSON.parse(decodeURIComponent(first.value)).t);
  assertEquals(bound.r, RID);
});

Deno.test("ref-bind negative controls: bad rid, other partner, no cookie, forged/expired cookie, wrong method/header", async () => {
  const good = pcCookieHeader("ABC123", new Date());
  // malformed rid
  for (const rid of ["not-a-uuid", "", "11111111-1111-4111-8111-11111111111", RID + "x", "1111111111114111811111111111111111"]) {
    const r = await bind({ rid, cookie: good });
    assertEquals(r.status, 400, `rid ${rid}`);
    assertEquals(r.headers.get("set-cookie"), null);
  }
  // cookie names a different partner than the click being bound
  let r = await bind({ rid: RID, code: "OTHER", cookie: good });
  assertEquals(r.status, 204);
  assertEquals(r.headers.get("set-cookie"), null);
  // no oq_pc at all (did not arrive via /ref/<code>)
  r = await bind({ rid: RID, cookie: null });
  assertEquals(r.status, 204);
  assertEquals(r.headers.get("set-cookie"), null);
  // future-dated (forged) and expired cookies are not bound
  r = await bind({ rid: RID, cookie: pcCookieHeader("ABC123", new Date(Date.now() + 3650 * 24 * 3600 * 1000)) });
  assertEquals(r.headers.get("set-cookie"), null);
  r = await bind({ rid: RID, cookie: pcCookieHeader("ABC123", new Date(Date.now() - 91 * 24 * 3600 * 1000)) });
  assertEquals(r.headers.get("set-cookie"), null);
  // unsafe code in the cookie
  r = await bind({ rid: RID, code: "a;b", cookie: pcCookieHeader("a;b", new Date()) });
  assertEquals(r.headers.get("set-cookie"), null);
  // GET and a POST without the custom header are refused
  r = await bind({ rid: RID, cookie: good, method: "GET" });
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("set-cookie"), null);
  r = await bind({ rid: RID, cookie: good, header: false });
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("set-cookie"), null);
});

Deno.test("ref-bind: buildPartnerCookie is unchanged for plain /ref clicks (no rid)", () => {
  const c = buildPartnerCookie("ABC123")!;
  assertEquals(c.includes("%22r%22"), false);
});
