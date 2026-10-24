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
// at the edge. gh-3009: it now verifies the token's signature through Supabase
// Auth (GET /auth/v1/user); these tests stub globalThis.fetch to play Supabase
// Auth, so they stay pure-unit with no network and no secrets.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "../edge-functions/admin-auth-gate.ts";

function base64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds a token of the right shape (header.payload.sig). Its signature is
// never checked locally; the stubbed Supabase Auth decides validity.
function makeToken(payload: Record<string, unknown>): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const body = base64url(payload);
  return `${header}.${body}.unsigned`;
}

// Stubs Supabase Auth. verifiedAs = email it returns for a valid token;
// null = it rejects the token (401), like a forged signature; "throw" = unreachable.
const realFetch = globalThis.fetch;
// gh-3009 item 2: the gate no longer carries an allow-list; it asks the server
// (POST /rest/v1/rpc/is_admin_email). `admins` plays the admin_emails table.
const TEST_ADMINS = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];
function stubSupabaseAuth(
  verifiedAs: string | null,
  admins: string[] = TEST_ADMINS,
  rpc: "ok" | "error" | "nonboolean" = "ok",
) {
  const calls: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    if (verifiedAs === "throw") throw new Error("network down");
    if (verifiedAs === null) return new Response('{"msg":"invalid JWT"}', { status: 401 });
    if (String(input).endsWith("/rest/v1/rpc/is_admin_email")) {
      if (rpc === "error") return new Response('{"message":"boom"}', { status: 500 });
      if (rpc === "nonboolean") return new Response('"true"', { status: 200 });
      return new Response(JSON.stringify(admins.includes(verifiedAs)), { status: 200 });
    }
    return new Response(JSON.stringify({ email: verifiedAs }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
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
  const stub = stubSupabaseAuth("not-an-admin@example.com");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: valid token + allow-listed email (new sb-otterquote-at cookie) -> page served via context.next()", async () => {
  const token = makeToken({ email: "dustin@otterquote.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("dustin@otterquote.com");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(stub.calls.length, 2);
  assertEquals(stub.calls[0].url, "https://yeszghaspzwwstvsrioa.supabase.co/auth/v1/user");
  assertEquals(stub.calls[0].auth, `Bearer ${token}`);
  assertEquals(stub.calls[1].url, "https://yeszghaspzwwstvsrioa.supabase.co/rest/v1/rpc/is_admin_email");
  assertEquals(stub.calls[1].auth, `Bearer ${token}`);

  assertEquals(ctx.nextCalled, true);
  assertEquals(await res.text(), "admin-page-served");
});

Deno.test("admin-auth-gate: D-225 legacy sb_at cookie still works during migration", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb_at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("dustinstohler1@gmail.com");
  await handler(req, ctx).finally(stub.restore);

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

// gh-3009: forged signature. Payload claims an unexpired allow-listed admin, but Supabase Auth rejects it.

Deno.test("admin-auth-gate: forged-signature token claiming an admin email -> redirect, page never served", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth(null);
  const res = await handler(req, ctx).finally(stub.restore);
  assertEquals(stub.calls.length, 1);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: payload email is ignored; the verified email decides", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("attacker@example.com");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: Supabase Auth unreachable -> fail closed", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("throw");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

// gh-3009 item 2: the server-side check is the only authority. The gate has no
// email literal of its own, so an email the server does not list is refused.
Deno.test("admin-auth-gate: server says not admin (empty admin_emails) -> redirect even for a once-listed email", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("dustinstohler1@gmail.com", []);
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: is_admin_email RPC errors -> fail closed", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("dustinstohler1@gmail.com", TEST_ADMINS, "error");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("admin-auth-gate: is_admin_email returns a non-boolean-true body -> fail closed", async () => {
  const token = makeToken({ email: "dustinstohler1@gmail.com", exp: futureExp() });
  const req = new Request("https://otterquote.com/admin-dashboard", {
    headers: { cookie: `sb-otterquote-at=${token}` },
  });
  const ctx = fakeContext();
  const stub = stubSupabaseAuth("dustinstohler1@gmail.com", TEST_ADMINS, "nonboolean");
  const res = await handler(req, ctx).finally(stub.restore);

  assertEquals(res.status, 302);
  assertEquals(ctx.nextCalled, false);
});
