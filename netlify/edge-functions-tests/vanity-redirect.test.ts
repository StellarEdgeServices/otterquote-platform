// Deno unit tests for vanity-redirect.ts (P18, #3232).
// Run: deno test netlify/edge-functions-tests/vanity-redirect.test.ts
// Pure-unit: fake Netlify context and a stubbed fetch standing in for the resolve_partner_slug RPC. No network, no secrets.
// The stub models the RPC contract (supabase/migrations_drafts/p18_resolve_partner_slug.sql): unique_code for an active
// holder; null for unknown, suspended-holder and reserved names. The SQL itself is proven separately against a database.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import handler from "../edge-functions/vanity-redirect.ts";

function fakeContext(status: number) {
  let nextCalled = 0;
  return {
    next: async () => {
      nextCalled++;
      return new Response(status === 404 ? "not found" : "page", { status });
    },
    get nextCalled() {
      return nextCalled;
    },
  };
}

// slug -> RPC answer. Anything not listed is null (unknown / suspended holder / reserved all resolve to null server-side).
const RPC: Record<string, string | null> = {
  jane: "JANE123",
  suspendedsue: null, // holder not active -> null
  terms: null, // reserved -> null
};

async function withFetchStub(fn: (calls: { url: string; slug: string; apikey: string | null }[]) => Promise<void>) {
  const calls: { url: string; slug: string; apikey: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ url: String(input), slug: body.p, apikey: new Headers(init?.headers).get("apikey") });
    return new Response(JSON.stringify(RPC[body.p] ?? null), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("vanity-redirect: /jane 302s to /ref/<code> keeping utm params, no-store", async () => {
  await withFetchStub(async (calls) => {
    const ctx = fakeContext(404);
    const res = await handler(new Request("https://otterquote.com/jane?utm_source=ig&utm_campaign=fall"), ctx);
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.origin + loc.pathname, "https://otterquote.com/ref/JANE123");
    assertEquals(loc.searchParams.get("utm_source"), "ig");
    assertEquals(loc.searchParams.get("utm_campaign"), "fall");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(ctx.nextCalled, 1); // next() ran first
    assertEquals(calls.length, 1);
    assertEquals(calls[0].slug, "jane");
    assert(calls[0].url.endsWith("/rest/v1/rpc/resolve_partner_slug"));
  });
});

Deno.test("vanity-redirect: lookup is case-insensitive (/Jane)", async () => {
  await withFetchStub(async (calls) => {
    const res = await handler(new Request("https://otterquote.com/Jane"), fakeContext(404));
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "https://otterquote.com/ref/JANE123");
    assertEquals(calls[0].slug, "jane");
  });
});

Deno.test("vanity-redirect: /faq is served normally and the lookup is never called", async () => {
  await withFetchStub(async (calls) => {
    const ctx = fakeContext(200);
    const res = await handler(new Request("https://otterquote.com/faq"), ctx);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "page");
    assertEquals(calls.length, 0);
  });
});

Deno.test("vanity-redirect: an unknown slug returns the 404", async () => {
  await withFetchStub(async (calls) => {
    const res = await handler(new Request("https://otterquote.com/nobodyhere"), fakeContext(404));
    assertEquals(res.status, 404);
    assertEquals(res.headers.get("location"), null);
    assertEquals(calls.length, 1);
  });
});

Deno.test("vanity-redirect: a suspended partner's slug returns 404", async () => {
  await withFetchStub(async (calls) => {
    const res = await handler(new Request("https://otterquote.com/suspendedsue"), fakeContext(404));
    assertEquals(res.status, 404);
    assertEquals(calls[0].slug, "suspendedsue");
  });
});

Deno.test("vanity-redirect: a reserved name returns 404", async () => {
  await withFetchStub(async () => {
    const res = await handler(new Request("https://otterquote.com/terms"), fakeContext(404));
    assertEquals(res.status, 404);
  });
});

Deno.test("vanity-redirect: a multi-segment path is passed through, no lookup", async () => {
  await withFetchStub(async (calls) => {
    for (const path of ["/jane/extra", "/blog/jane", "/ref/jane"]) {
      const ctx = fakeContext(404);
      const res = await handler(new Request("https://otterquote.com" + path), ctx);
      assertEquals(res.status, 404);
      assertEquals(ctx.nextCalled, 1);
    }
    assertEquals(calls.length, 0);
  });
});

Deno.test("vanity-redirect: malformed segments never reach the lookup", async () => {
  await withFetchStub(async (calls) => {
    for (const path of ["/ab", "/12345", "/-jane", "/jane-", "/ja--ne", "/jane.html", "/ja%20ne", "/" + "a".repeat(31), "/%E0%A4%A"]) {
      const res = await handler(new Request("https://otterquote.com" + path), fakeContext(404));
      assertEquals(res.status, 404);
    }
    assertEquals(calls.length, 0);
  });
});

Deno.test("vanity-redirect: lookup failure or hostile reply passes the 404 through", async () => {
  const real = globalThis.fetch;
  try {
    for (const make of [
      () => { throw new Error("network down"); },
      () => new Response("oops", { status: 500 }),
      () => new Response(JSON.stringify("../evil?x=1"), { status: 200 }),
      () => new Response(JSON.stringify({ code: "X" }), { status: 200 }),
    ]) {
      globalThis.fetch = (async () => make()) as unknown as typeof fetch;
      const res = await handler(new Request("https://otterquote.com/jane"), fakeContext(404));
      assertEquals(res.status, 404);
    }
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("vanity-redirect: non-GET requests are passed through", async () => {
  await withFetchStub(async (calls) => {
    const res = await handler(new Request("https://otterquote.com/jane", { method: "POST" }), fakeContext(404));
    assertEquals(res.status, 404);
    assertEquals(calls.length, 0);
  });
});

Deno.test("vanity-redirect: a lookup that never answers times out and falls back to the 404", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((_input: any, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    })) as unknown as typeof fetch;
  try {
    const started = Date.now();
    const res = await handler(new Request("https://otterquote.com/jane"), fakeContext(404));
    assertEquals(res.status, 404);
    assert(Date.now() - started < 5000);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("vanity-redirect: HEAD returns 302 with no body and no-store", async () => {
  await withFetchStub(async (calls) => {
    const res = await handler(new Request("https://otterquote.com/jane?utm_source=ig", { method: "HEAD" }), fakeContext(404));
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "https://otterquote.com/ref/JANE123?utm_source=ig");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.body, null);
    assertEquals(calls.length, 1);
  });
});
