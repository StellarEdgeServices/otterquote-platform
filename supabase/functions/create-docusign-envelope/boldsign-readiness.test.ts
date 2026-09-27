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
  clearStrandedEnvelopePointer,
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

// ---------------------------------------------------------------------------
// gh-1842 (resume-path follow-up, per Marty CTO RUN 42 comment 5850771831 on
// #1842): the RESUME path (requestBody.resolved_envelope_id in
// handleContractorSign) discovers the SAME permanent-failure class as the
// mint path, but on a later retry rather than at mint time -- so it must
// clear the stranded pointer with the same fields and the same guard. index.ts
// is a single-file EF with a serve() at the bottom and cannot be imported by
// a test (same constraint noted in the original #1868 PR body), so the shared
// clear logic lives in this module, exported as clearStrandedEnvelopePointer,
// and BOTH the mint-path and resume-path call sites in index.ts call it. The
// harness below reproduces each call site's exact try/catch shape --
// including the isPermanentCreationFailure() gate -- against a fake supabase
// client, so this is the same decision index.ts makes, not a looser stand-in.
// resume-clear-wiring.test.ts (in this same directory) checks index.ts's
// actual source text against these same anchors, so a change to the real
// call site that drifts from this harness fails there, not silently here.
//
// FAIL-FIRST: on main, clearStrandedEnvelopePointer does not exist, so this
// whole file fails to even import (a compile-time ReferenceError from the
// missing export), which is a fail-first result at the file level -- the
// resume path on main has no clear logic to test at all.
//
// REVIEW FAIL (PR #2240, F1): resumedEnvelopeId is NOT guaranteed to live on
// the caller's own quote_id -- findExistingEnvelopeId() can resolve it via
// the (claim_id, contractor_id) fallback instead. index.ts's real resume
// call site therefore passes quote_id: null (see resume-clear-wiring.test.ts),
// forcing clearStrandedEnvelopePointer's claim_id+contractor_id branch, which
// is now ALSO guarded on .eq("docusign_envelope_id", envelopeId). The tests
// below exercise that exact shape, not the untrusted quote_id.

/**
 * A minimal chainable fake mirroring supabase-js's
 * from().update().eq()...select("id") shape that clearStrandedEnvelopePointer
 * now uses. `rowsByTable` controls what `.select("id")` resolves with per
 * table -- default is one matched row; pass `[]` to simulate a zero-row
 * match (gh-2105 detection, not an `update-no-select-ok` annotation).
 */
function fakeSupabaseRecordingCalls(
  calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }>,
  rowsByTable: Record<string, Array<{ id: string }>> = {},
) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let payload: unknown = null;
      const builder = {
        update(p: unknown) {
          payload = p;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return builder;
        },
        select(_cols: string) {
          calls.push({ table, payload, filters: [...filters] });
          const data = table in rowsByTable ? rowsByTable[table] : [{ id: "matched-row" }];
          return Promise.resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
}

/**
 * Reproduces handleContractorSign's resume-branch try/catch exactly (index.ts
 * ~L1932-1976): attempt the sign-link call; on a PROVEN-permanent failure
 * only, clear via clearStrandedEnvelopePointer with quote_id forced to null
 * (see the REVIEW FAIL note above); anything else rethrows uncleared.
 * `attempt` stands in for issueContractorSignLink().
 */
async function simulateResumeSignAttempt(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  target: { claim_id: string; contractor_id: string; envelopeId: string },
  attempt: () => Promise<unknown>,
) {
  try {
    return await attempt();
  } catch (err) {
    if (!isPermanentCreationFailure(err)) throw err;
    await clearStrandedEnvelopePointer(supabase, { ...target, quote_id: null });
    throw err;
  }
}

Deno.test("resume path: PERMANENT failure clears quotes+claims, guarded on the envelope id (not the untrusted quote_id)", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  const supabase = fakeSupabaseRecordingCalls(calls);
  const err = new BoldSignPermanentCreationFailure(DEAD, "resume-path fixture");

  let caught: unknown = null;
  try {
    await simulateResumeSignAttempt(
      supabase,
      { claim_id: "claim-1", contractor_id: "contractor-1", envelopeId: DEAD },
      () => { throw err; },
    );
  } catch (e) {
    caught = e;
  }

  assert(caught === err, "must rethrow the original permanent error after clearing");
  assertEquals(calls.length, 2, "must issue exactly one quotes update and one claims update");

  const quotesCall = calls.find((c) => c.table === "quotes")!;
  assertEquals(quotesCall.payload, { docusign_envelope_id: null });
  assertEquals(
    quotesCall.filters,
    [["claim_id", "claim-1"], ["contractor_id", "contractor-1"], ["docusign_envelope_id", DEAD]],
    "the resume path must clear by claim_id+contractor_id+envelope guard, never by a quote_id it does not trust",
  );

  const claimsCall = calls.find((c) => c.table === "claims")!;
  assertEquals(claimsCall.payload, { docusign_envelope_id: null, contract_sent_at: null });
  assertEquals(
    claimsCall.filters,
    [["id", "claim-1"], ["docusign_envelope_id", DEAD]],
    "the claims clear must stay guarded on the exact envelope id, so it cannot wipe a pointer something else has since replaced",
  );
});

Deno.test("resume path: TIMEOUT (transient) failure does NOT clear — negative control", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  const supabase = fakeSupabaseRecordingCalls(calls);
  const err = new BoldSignReadinessTimeout(SLOW, 15000, "still building");

  let caught: unknown = null;
  try {
    await simulateResumeSignAttempt(
      supabase,
      { claim_id: "claim-1", contractor_id: "contractor-1", envelopeId: SLOW },
      () => { throw err; },
    );
  } catch (e) {
    caught = e;
  }

  assert(caught === err, "a timeout must still be rethrown, untouched");
  assertEquals(calls.length, 0, "a timeout must NOT clear the envelope pointer -- it would re-mint a second paid document over one that is merely slow");
});

Deno.test("resume path: a successful resume (no error at all) does not touch quotes/claims", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  const supabase = fakeSupabaseRecordingCalls(calls);

  const result = await simulateResumeSignAttempt(
    supabase,
    { claim_id: "claim-1", contractor_id: "contractor-1", envelopeId: SLOW },
    () => Promise.resolve({ signingUrl: "https://example.test/sign" }),
  );

  assertEquals(result, { signingUrl: "https://example.test/sign" });
  assertEquals(calls.length, 0);
});

Deno.test("clearStrandedEnvelopePointer: quote_id branch is ALSO guarded on the envelope id (mint path, F1 fix)", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  const supabase = fakeSupabaseRecordingCalls(calls);

  await clearStrandedEnvelopePointer(supabase, {
    claim_id: "claim-3",
    quote_id: "quote-3",
    contractor_id: "contractor-3",
    envelopeId: DEAD,
  });

  const quotesCall = calls.find((c) => c.table === "quotes")!;
  assertEquals(
    quotesCall.filters,
    [["id", "quote-3"], ["docusign_envelope_id", DEAD]],
    "even the mint path's own quote_id must be guarded on the envelope id -- a concurrent mint could have already overwritten it",
  );
});

Deno.test("clearStrandedEnvelopePointer falls back to claim_id+contractor_id+envelope-guard when quote_id is absent", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  const supabase = fakeSupabaseRecordingCalls(calls);

  await clearStrandedEnvelopePointer(supabase, {
    claim_id: "claim-2",
    quote_id: null,
    contractor_id: "contractor-2",
    envelopeId: DEAD,
  });

  const quotesCall = calls.find((c) => c.table === "quotes")!;
  assertEquals(quotesCall.filters, [["claim_id", "claim-2"], ["contractor_id", "contractor-2"], ["docusign_envelope_id", DEAD]]);
});

Deno.test("clearStrandedEnvelopePointer: a zero-row match is DETECTED (gh-2105), not silently annotated away", async () => {
  const calls: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
  // The quotes write matches nothing -- e.g. something else already cleared
  // or replaced this exact pointer. checkRowsWritten() must report 0, and
  // this must NOT surface as an error (it is a legitimate outcome, gh-2105
  // decision b), only as a zero count the caller can log.
  const supabase = fakeSupabaseRecordingCalls(calls, { quotes: [] });

  const { quoteClearError, claimClearError, quoteRows, claimRows } = await clearStrandedEnvelopePointer(supabase, {
    claim_id: "claim-4",
    quote_id: "quote-4",
    contractor_id: "contractor-4",
    envelopeId: DEAD,
  });

  assertEquals(quoteClearError, null);
  assertEquals(quoteRows, 0, "a zero-row quotes match must be reported, not swallowed");
  assertEquals(claimClearError, null);
  assertEquals(claimRows, 1, "the claims write in this fixture still matched its one row");
});

// ---------------------------------------------------------------------------
// REVIEW FAIL round 2 (PR #2240, 5851036566), fix 2: fakeSupabaseRecordingCalls
// only checks the SHAPE of the filters a call site requests -- it proves the
// right .eq() calls were made, not that they actually protect a row. A
// STATEFUL fake that applies those filters against seeded in-memory rows is
// needed to prove the two scenarios REVIEW round 1 (F1) raised: a concurrent
// mint's replacement pointer must survive, and the guarded fallback must hit
// the RIGHT row when a claim/contractor has more than one quote.

/**
 * A stateful chainable fake: `.update(payload).eq(...).eq(...).select("id")`
 * actually filters the seeded rows and mutates only the ones that match, so
 * assertions can check the ROWS afterward, not just which filters were sent.
 */
function statefulFakeSupabase(seed: { quotes: Record<string, unknown>[]; claims: Record<string, unknown>[] }) {
  function tableOps(rows: Record<string, unknown>[]) {
    return {
      update(payload: Record<string, unknown>) {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            return builder;
          },
          select(_cols: string) {
            const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
            for (const r of matched) Object.assign(r, payload);
            return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
          },
        };
        return builder;
      },
    };
  }
  return {
    from(table: "quotes" | "claims") {
      return tableOps(seed[table]);
    },
  };
}

Deno.test("clearStrandedEnvelopePointer (stateful): a REPLACEMENT pointer from a concurrent mint survives the clear", async () => {
  // Requests A and B both resumed the same dead document. A already cleared
  // and mint C wrote NEW over the pointer. B's clear (for the dead id) must
  // NOT wipe NEW -- that would be gh-1400's failure, inverted.
  const seed = {
    quotes: [{ id: "q1", claim_id: "c1", contractor_id: "k1", docusign_envelope_id: "NEW" }],
    claims: [{ id: "c1", docusign_envelope_id: "NEW", contract_sent_at: "x" }],
  };
  const db = statefulFakeSupabase(seed);

  const { quoteRows, claimRows } = await clearStrandedEnvelopePointer(db, {
    claim_id: "c1",
    quote_id: null,
    contractor_id: "k1",
    envelopeId: DEAD,
  });

  assertEquals(quoteRows, 0, "the clear must not match the row now holding a DIFFERENT (replacement) envelope id");
  assertEquals(claimRows, 0, "same for claims");
  assertEquals(seed.quotes[0].docusign_envelope_id, "NEW", "the replacement pointer must survive untouched");
  assertEquals(seed.claims[0].docusign_envelope_id, "NEW");
  assertEquals(seed.claims[0].contract_sent_at, "x", "contract_sent_at must not be wiped either");
});

Deno.test("clearStrandedEnvelopePointer (stateful): the guarded fallback clears the RIGHT quote among several for the same claim+contractor", async () => {
  // q1 has no envelope, q2 holds the dead document, q3 holds an unrelated
  // live one. An unguarded claim_id+contractor_id-only filter would match
  // ALL THREE; the envelope guard must narrow it to q2 alone.
  const seed = {
    quotes: [
      { id: "q1", claim_id: "c1", contractor_id: "k1", docusign_envelope_id: null },
      { id: "q2", claim_id: "c1", contractor_id: "k1", docusign_envelope_id: DEAD },
      { id: "q3", claim_id: "c1", contractor_id: "k1", docusign_envelope_id: "OTHER" },
    ],
    claims: [{ id: "c1", docusign_envelope_id: DEAD, contract_sent_at: "x" }],
  };
  const db = statefulFakeSupabase(seed);

  const { quoteRows, claimRows } = await clearStrandedEnvelopePointer(db, {
    claim_id: "c1",
    quote_id: null,
    contractor_id: "k1",
    envelopeId: DEAD,
  });

  assertEquals(quoteRows, 1, "exactly the one quote holding the dead id must be cleared");
  assertEquals(claimRows, 1);
  assertEquals(
    seed.quotes.map((q) => q.docusign_envelope_id),
    [null, null, "OTHER"],
    "q1 stays null, q2 (the dead one) is cleared, q3's unrelated live document is untouched",
  );
  assertEquals(seed.claims[0].docusign_envelope_id, null);
  assertEquals(seed.claims[0].contract_sent_at, null);
});
