// Deno unit tests for first-touch-attribution.ts (gh-1983).
// Run: deno test netlify/edge-functions-tests/first-touch-attribution.test.ts
// Pure-unit, fake Netlify context — same convention as ref-redirect.test.ts.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "../edge-functions/first-touch-attribution.ts";
import { deserializeFirstTouch, readCookieValue } from "../../react-app/app/lib/attribution-core.ts";

function fakeContext(response?: Response) {
  let nextCalled = false;
  return {
    next: async () => {
      nextCalled = true;
      return response ?? new Response("page", { status: 200, headers: { "content-type": "text/html" } });
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

function cookieFrom(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

Deno.test("tagged landing sets oq_ft on .otterquote.com with the params", async () => {
  const req = new Request(
    "https://otterquote.com/?utm_source=fb&utm_campaign=test&fbclid=x#access_token=SHOULD_NOT_APPEAR",
    { headers: { referer: "https://lm.facebook.com/l.php?u=abc" } },
  );
  const ctx = fakeContext();
  const res = await handler(req, ctx);
  assert(res instanceof Response, "a response is returned");
  assert(ctx.nextCalled);
  const c = cookieFrom(res);
  assert(c.startsWith("oq_ft="), c);
  assert(c.includes("Domain=.otterquote.com"), c);
  assert(c.includes("Max-Age=7776000"), c);
  assert(c.includes("Secure"), c);
  assert(!c.includes("SHOULD_NOT_APPEAR"), "fragment never stored");
  const ft = deserializeFirstTouch(readCookieValue(c.split(";")[0], "oq_ft"));
  assertEquals(ft?.utm_source, "fb");
  assertEquals(ft?.utm_campaign, "test");
  assertEquals(ft?.fbclid, "x");
  assertEquals(ft?.landing_path, "/");
  assertEquals(ft?.referrer, "lm.facebook.com");
  assertEquals(await res.text(), "page");
});

Deno.test("the /get-started 301 keeps its status and Location and gains the cookie", async () => {
  const redirect = new Response(null, {
    status: 301,
    headers: { location: "https://app.otterquote.com/get-started?gclid=g1" },
  });
  const req = new Request("https://otterquote.com/get-started?gclid=g1");
  const res = await handler(req, fakeContext(redirect));
  assert(res instanceof Response, "a response is returned");
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("location"), "https://app.otterquote.com/get-started?gclid=g1");
  assert(cookieFrom(res).includes("gclid"), cookieFrom(res));
});

Deno.test("NEGATIVE CONTROL: untagged request passes through untouched", async () => {
  const ctx = fakeContext();
  const res = await handler(new Request("https://otterquote.com/?track=insurance"), ctx);
  assertEquals(res, undefined);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("an existing valid first touch is never overwritten", async () => {
  const existing = encodeURIComponent(JSON.stringify({ v: 1, utm_source: "youtube", ts: "2026-09-01T00:00:00.000Z" }));
  const ctx = fakeContext();
  const res = await handler(
    new Request("https://otterquote.com/?utm_source=fb", { headers: { cookie: `other=1; oq_ft=${existing}` } }),
    ctx,
  );
  assertEquals(res, undefined);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("a malformed stored cookie does not block a new tagged touch", async () => {
  const res = await handler(
    new Request("https://otterquote.com/?utm_source=fb", { headers: { cookie: "oq_ft=%7Bnot-json" } }),
    fakeContext(),
  );
  assert(res instanceof Response, "a response is returned");
  assert(cookieFrom(res).startsWith("oq_ft="));
});

Deno.test("a long real-world fbclid (>200 chars) is kept whole", async () => {
  const fbclid = "IwY2xjawF" + "a".repeat(400);
  const res = await handler(new Request(`https://otterquote.com/?fbclid=${fbclid}`), fakeContext());
  assert(res instanceof Response, "a response is returned");
  const ft = deserializeFirstTouch(readCookieValue(cookieFrom(res).split(";")[0], "oq_ft"));
  assertEquals(ft?.fbclid, fbclid);
});

Deno.test("non-GET requests are ignored", async () => {
  const ctx = fakeContext();
  const res = await handler(new Request("https://otterquote.com/?utm_source=fb", { method: "POST" }), ctx);
  assertEquals(res, undefined);
  assertEquals(ctx.nextCalled, false);
});

Deno.test("preview hosts get a host-only cookie (no Domain attribute)", async () => {
  const res = await handler(
    new Request("https://deploy-preview-1--jade-alpaca-b82b5e.netlify.app/?utm_source=fb"),
    fakeContext(),
  );
  assert(res instanceof Response, "a response is returned");
  const c = cookieFrom(res);
  assert(c.startsWith("oq_ft="));
  assert(!c.includes("Domain="), c);
});
