// gh-1842 — the control this issue's closes-on asks for.
//
// A check that rejects both fixtures, or neither, is not a check. So every
// assertion below is paired: the permanently-failed document must be REJECTED
// as permanent, and the slow-but-fine document must be ACCEPTED — by the same
// code, in the same run, distinguished only by what BoldSign returns.
//
// Fixtures are modelled on the raw responses measured against the live
// production key on 2026-09-08 and pasted on #1842:
//   POST /v1/document/send                     -> 201 {"documentId":"09400a4b-..."}
//   GET  /v1/document/properties?documentId=.. -> 403 {"error":"Forbidden"}  (+1s, +15s, +30s, +3h)
//   GET  /v1/document/list (every Status)      -> 200, and 09400a4b is in NONE of them
//   ...while all 6 documents that DID finish creation return 200 properties.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BOLDSIGN_PERMANENT_MARKER,
  BoldSignPermanentCreationFailure,
  BoldSignReadinessTimeout,
  isPermanentCreationFailure,
  waitForBoldSignDocumentReady,
} from "./boldsign-readiness.ts";

const API = "https://api.boldsign.test";
const DEAD = "09400a4b-6682-4ee5-b3bb-c73dfc854ad3"; // the real stranded document on #1842
const SLOW = "11111111-2222-3333-4444-555555555555";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake clock so the tests exercise the 15 s ceiling without waiting 15 s. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * @param listedIds documents BoldSign admits to knowing about
 * @param readyAfterCalls properties returns 200 from this call number onward (Infinity = never)
 */
function fakeBoldSign(
  { listedIds, readyAfterCalls = Infinity, listStatus = 200 }: {
    listedIds: string[];
    readyAfterCalls?: number;
    listStatus?: number;
  },
) {
  const calls = { properties: 0, list: 0 };
  const fetchImpl = ((url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/v1/document/properties")) {
      calls.properties++;
      if (calls.properties >= readyAfterCalls) return Promise.resolve(json(200, { status: "InProgress" }));
      return Promise.resolve(json(403, { error: "Forbidden" }));
    }
    if (u.includes("/v1/document/list")) {
      calls.list++;
      if (listStatus !== 200) return Promise.resolve(json(listStatus, { error: "Internal Server Error" }));
      const status = new URL(u).searchParams.get("Status");
      // Every listed document is reported under InProgress, as the live account does.
      const rows = status === "InProgress" ? listedIds.map((id) => ({ documentId: id })) : [];
      return Promise.resolve(json(200, { result: rows }));
    }
    throw new Error("unexpected fetch: " + u);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test("PERMANENT failure is named as permanent — the RED fixture", async () => {
  const clock = fakeClock();
  // BoldSign knows about six other documents and not about this one.
  const { fetchImpl, calls } = fakeBoldSign({
    listedIds: ["aaa", "bbb", "ccc", "ddd", "eee", "fff"],
  });

  let caught: unknown = null;
  try {
    await waitForBoldSignDocumentReady(DEAD, {
      apiBase: API,
      headers: { "X-API-KEY": "test" },
      fetchImpl,
      intervalMs: 1000,
      ceilingMs: 15000,
      absenceProbeAfterMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    });
  } catch (e) {
    caught = e;
  }

  assert(caught instanceof BoldSignPermanentCreationFailure, "must throw the permanent class");
  assert(isPermanentCreationFailure(caught), "must be classified permanent");
  assertStringIncludes((caught as Error).message, BOLDSIGN_PERMANENT_MARKER);
  assertStringIncludes((caught as Error).message, DEAD);

  // The old message is now the WRONG diagnosis for this case and must not print.
  const msg = (caught as Error).message;
  assert(
    !msg.includes("This is a wait timeout, not a permission or"),
    "must not reuse the gh-1244 wait-timeout sentence for a permanent failure",
  );
  assertStringIncludes(msg, "FAILED PERMANENTLY");

  // It must give up on the evidence, not by burning the whole ceiling.
  assert(calls.list > 0, "must actually probe the list endpoint");
  assert(clock.now() < 15000, `must fail before the ceiling, stopped at ${clock.now()}ms`);
});

Deno.test("SLOW-but-fine document is accepted — the GREEN fixture beside it", async () => {
  const clock = fakeClock();
  // 403s for a while (like gh-1244's 2.5 s), listed the whole time, then 200.
  const { fetchImpl } = fakeBoldSign({
    listedIds: [SLOW, "aaa"],
    readyAfterCalls: 9,
  });

  await waitForBoldSignDocumentReady(SLOW, {
    apiBase: API,
    headers: { "X-API-KEY": "test" },
    fetchImpl,
    intervalMs: 1000,
    ceilingMs: 15000,
    absenceProbeAfterMs: 5000,
    now: clock.now,
    sleep: clock.sleep,
  });
  // No throw. gh-1244's behaviour is preserved: a 403 is not a failure.
});

Deno.test("still-building at the ceiling is a TIMEOUT, not a permanent failure", async () => {
  const clock = fakeClock();
  const { fetchImpl } = fakeBoldSign({ listedIds: [SLOW] }); // listed, never ready

  let caught: unknown = null;
  try {
    await waitForBoldSignDocumentReady(SLOW, {
      apiBase: API,
      headers: { "X-API-KEY": "test" },
      fetchImpl,
      intervalMs: 1000,
      ceilingMs: 15000,
      absenceProbeAfterMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof BoldSignReadinessTimeout, "listed-but-slow must be a timeout");
  assertEquals(isPermanentCreationFailure(caught), false);
  assertStringIncludes((caught as Error).message, "still in progress rather than failed");
  assertStringIncludes((caught as Error).message, "must NOT be re-minted");
});

Deno.test("an UNREADABLE list endpoint is not evidence of absence", async () => {
  const clock = fakeClock();
  // /v1/document/list itself 500s — the live account did exactly this on
  // downloadAuditLog. Absence we could not observe must not condemn a document.
  const { fetchImpl } = fakeBoldSign({ listedIds: [], listStatus: 500 });

  let caught: unknown = null;
  try {
    await waitForBoldSignDocumentReady(DEAD, {
      apiBase: API,
      headers: { "X-API-KEY": "test" },
      fetchImpl,
      intervalMs: 1000,
      ceilingMs: 15000,
      absenceProbeAfterMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    });
  } catch (e) {
    caught = e;
  }
  assertEquals(isPermanentCreationFailure(caught), false);
  assert(caught instanceof BoldSignReadinessTimeout);
});

Deno.test("isPermanentCreationFailure is narrow — an ambiguous error never un-records", () => {
  assertEquals(isPermanentCreationFailure(new Error("network unreachable")), false);
  assertEquals(isPermanentCreationFailure(new BoldSignReadinessTimeout("x", 15000, "")), false);
  assertEquals(isPermanentCreationFailure(null), false);
  assertEquals(isPermanentCreationFailure(new BoldSignPermanentCreationFailure("x", "")), true);
});
