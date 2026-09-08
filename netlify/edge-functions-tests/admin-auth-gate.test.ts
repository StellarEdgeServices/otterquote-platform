// Deno unit tests for admin-auth-gate.ts (gh-1738).
// Run: deno test netlify/edge-functions-tests/admin-auth-gate.test.ts
//
// gh-1738 note: this file lives in netlify/edge-functions-tests/, a
// SIBLING of netlify/edge-functions/, not inside it. Netlify auto-discovers
// every .ts file directly under netlify/edge-functions/ as a deployable edge
// function candidate (confirmed empirically: an earlier version of this PR
// placed the test files there and broke the Netlify deploy preview build,
// exit code 2 -- see PR #1820 history). Keeping tests out of that directory
// entirely is the fix; the negative-control fixture follows the same rule.
//
// gh-1738: this gate is the ONLY thing standing in front of /admin-* pages
// at the edge (client-side JS and Supabase RLS are the other two layers per
// its own docstring), and it had zero automated coverage. No signature
// verification happens here by design (see the file's "Security model"
// comment), so these tests build unsigned tokens the same shape a real
// Supabase JWT has -- header.payload.signature, base64url -- without needing
// any secret. Pure-unit, no network, no secrets.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "../edge-functions/admin-auth-gate.ts";

function base64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds an unsigned token of the right shape (header.payload.sig). The
// gate never checks the signature (Option A, agreed May 1, 2026 -- RLS is
// the real data gate), so any third segment is accepted structurally.
function makeToken(payload: Record<string, unknown>): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const body = base64url(payload);
  return `${header}.${body}.unsigned`;
}

function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function pastExp(): number {
  return Math.floor(Date.now() / 1000) - 3600;
}

function fakeContext() {
  let nextCalled = false;
  return {
    next: async () => {
      nextCalled = true;
      return new Response("admin-page-served", { status: 200 });
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

Deno.test("admin-auth-gate: no cookie at all -> redirect to login, page never served", async () => {
  const req = new Request("https://otterquote.com/admin-dashboard");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 302);
  assertEquals(
    res.headers.get("location"),
    "https://otterquote.com/login.html?reason=admin_required",
  );
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: expired token -> redirect to login even with an allow-listed email", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: pastExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: valid, unexpired token but non-admin email -> redirect to login", async () => {
  const token = makeToken({ email: "not-an-admin@example.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: valid token + allow-listed email (new sb-otterquote-at cookie) -> page served via context.next()", async () => {
  const token = makeToken({ email: "dustin@otterquote.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
  assertEquals(await res.text(), "admin-page-served");
});

Deno.test("admin-auth-gate: D-225 legacy sb_at cookie still works during migration", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb_at=${token}` },
  });
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
});

Deno.test("admin-auth-gate: malformed token (not 3 segments) -> fail-closed redirect, not a throw", async () => {
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: "sb-otterquote-at=not-a-real-jwt" },
  });
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});
