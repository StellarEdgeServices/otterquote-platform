// Deno unit tests for blog-guides-redirect.ts (gh-1738).
// Run: deno test netlify/edge-functions/blog-guides-redirect.test.ts
//
// gh-1738 instance 5-analog: this function was ADDED (PR #1789) specifically
// because a fresh-context reviewer found the equivalent `_redirects` rules
// silently lost the race against Netlify's Pretty URLs post-processing --
// see this file's own header comment. Despite that history, it shipped with
// no automated test of its own; verification was a one-time manual curl.
// This is the first automated coverage it has had.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "./blog-guides-redirect.ts";

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

Deno.test("blog-guides-redirect: a mapped /blog/ path 301s to its .html twin", async () => {
  const req = new Request(
    "https://otterquote.com/blog/what-to-do-after-storm-damages-roof",
  );
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 301);
  assertEquals(
    res.headers.get("location"),
    "https://otterquote.com/blog/what-to-do-after-storm-damages-roof.html",
  );
  assertEquals(ctx.nextCalled, false);
});

Deno.test("blog-guides-redirect: a mapped /guides/ path 301s to its .html twin and forwards query params", async () => {
  const req = new Request(
    "https://otterquote.com/guides/how-to-choose-contractor?utm_campaign=fall",
  );
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  const location = new URL(res.headers.get("location")!);
  assertEquals(res.status, 301);
  assertEquals(location.pathname, "/guides/how-to-choose-contractor.html");
  assertEquals(location.searchParams.get("utm_campaign"), "fall");
});

Deno.test("blog-guides-redirect: an unmapped path falls through via context.next() -- exact-match only, no wildcard", async () => {
  const req = new Request("https://otterquote.com/blog/some-other-post");
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
  assertEquals(await res.text(), "next-called");
});

Deno.test("blog-guides-redirect: the .html twin itself is not in the map and falls through unchanged", async () => {
  const req = new Request(
    "https://otterquote.com/blog/what-to-do-after-storm-damages-roof.html",
  );
  const ctx = fakeContext();
  const res = await handler(req, ctx);

  assertEquals(ctx.nextCalled, true);
});
