// gh-3428: owner-alert-sweep unit tests. No network, no Twilio, no call: Twilio is a fake fetch and the database is an in-memory model of
// owner_alerts that mirrors the SQL rules (the SQL itself is proven on a throwaway Postgres: supabase/tests/gh3428_owner_alert_sweep_proof.sql).
// Run: deno test --allow-read=supabase/functions supabase/functions/owner-alert-sweep/sweep.test.ts

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  authorizeServiceOnly, buildTwiml, CallError, MAX_ATTEMPTS, placeCall, runSweep, shortClaimId, type LeasedAlert, type SweepDeps,
} from "./sweep.ts";

const OWNER_PLACEHOLDER = "OWNER_NUMBER_PLACEHOLDER";   // deliberately not a number: no phone number lives in this repo
const FROM_PLACEHOLDER = "TWILIO_NUMBER_PLACEHOLDER";
const CFG = { accountSid: "ACtest", authToken: "tok", from: FROM_PLACEHOLDER, to: OWNER_PLACEHOLDER };
const CLAIM = "00000000-0000-0000-0000-00000000c101";

// ---- In-memory model of the SQL rules (claim_batch + mark), used to drive runSweep end to end ----
interface Src { kind: "measurement_paid" | "claim_bidding"; source_id: string; claim_id: string; state: string | null; is_test: boolean; qualifies: boolean }
interface Row { id: string; event_kind: string; source_id: string; claim_id: string; state: string | null; status: string; attempts: number; due: boolean; error: string | null }

function makeWorld(sources: Src[], baseline: string[] = []) {
  const rows: Row[] = baseline.map((s, i) => ({ id: `b${i}`, event_kind: "claim_bidding", source_id: s, claim_id: s, state: null, status: "baseline", attempts: 0, due: false, error: null }));
  const calls: LeasedAlert[] = [];
  let n = 0;
  const claimBatch = async (): Promise<LeasedAlert[]> => {
    for (const s of sources) {
      if (!s.qualifies || s.is_test) continue;                                    // the SQL's is_test / qualification filters
      if (rows.some((r) => r.event_kind === s.kind && r.source_id === s.source_id)) continue;   // the unique key
      rows.push({ id: `r${n++}`, event_kind: s.kind, source_id: s.source_id, claim_id: s.claim_id, state: s.state, status: "pending", attempts: 0, due: true, error: null });
    }
    const out: LeasedAlert[] = [];
    for (const r of rows) {
      if (out.length >= 5) break;
      if ((r.status === "pending" || r.status === "calling") && r.due && r.attempts < MAX_ATTEMPTS) {
        r.status = "calling"; r.attempts++; r.due = false;
        out.push({ id: r.id, event_kind: r.event_kind, claim_id: r.claim_id, state: r.state, attempts: r.attempts });
      }
    }
    return out;
  };
  const mark = async (id: string, ok: boolean, _sid: string | null, error: string | null) => {
    const r = rows.find((x) => x.id === id);
    if (!r || r.status !== "calling") return null;
    r.status = ok ? "called" : (r.attempts >= MAX_ATTEMPTS ? "failed_final" : "pending");
    r.error = ok ? null : error;
    r.due = !ok;     // retry becomes due on the next tick in this model
    return r.status;
  };
  return { rows, calls, claimBatch, mark };
}

function deps(world: ReturnType<typeof makeWorld>, place: SweepDeps["place"], reports: Array<{ op: string; extra?: Record<string, unknown> }> = []): SweepDeps {
  return { claimBatch: world.claimBatch, mark: world.mark, place, report: async (_e, ctx) => { reports.push(ctx); } };
}

const okPlace = (world: ReturnType<typeof makeWorld>): SweepDeps["place"] => async (a) => { world.calls.push(a); return "CA_FAKE"; };

Deno.test("a qualifying event produces exactly one call, and a second sweep produces none", async () => {
  const w = makeWorld([{ kind: "measurement_paid", source_id: "h1", claim_id: CLAIM, state: "OH", is_test: false, qualifies: true }]);
  const r1 = await runSweep(deps(w, okPlace(w)));
  assertEquals(r1.leased, 1); assertEquals(r1.called, 1); assertEquals(w.calls.length, 1);
  const r2 = await runSweep(deps(w, okPlace(w)));
  assertEquals(r2.leased, 0); assertEquals(w.calls.length, 1);   // still one
});

Deno.test("an is_test event produces no call (negative control)", async () => {
  const w = makeWorld([{ kind: "claim_bidding", source_id: CLAIM, claim_id: CLAIM, state: "OH", is_test: true, qualifies: true }]);
  const r = await runSweep(deps(w, okPlace(w)));
  assertEquals(r.leased, 0); assertEquals(w.calls.length, 0); assertEquals(w.rows.length, 0);
});

Deno.test("a non-qualifying event produces no call", async () => {
  const w = makeWorld([{ kind: "claim_bidding", source_id: CLAIM, claim_id: CLAIM, state: "OH", is_test: false, qualifies: false }]);
  const r = await runSweep(deps(w, okPlace(w)));
  assertEquals(r.leased, 0); assertEquals(w.calls.length, 0);
});

Deno.test("a baseline event (existed at install) produces no call", async () => {
  const w = makeWorld([{ kind: "claim_bidding", source_id: CLAIM, claim_id: CLAIM, state: "OH", is_test: false, qualifies: true }], [CLAIM]);
  const r = await runSweep(deps(w, okPlace(w)));
  assertEquals(r.leased, 0); assertEquals(w.calls.length, 0);
});

Deno.test("a failed call stays retryable, is retried, and stops at the attempt cap with a Sentry report each time", async () => {
  const w = makeWorld([{ kind: "claim_bidding", source_id: CLAIM, claim_id: CLAIM, state: "IN", is_test: false, qualifies: true }]);
  const reports: Array<{ op: string; extra?: Record<string, unknown> }> = [];
  let attempts = 0;
  const failing: SweepDeps["place"] = async () => { attempts++; throw new CallError("twilio_http_400_code_21211"); };
  const r1 = await runSweep(deps(w, failing, reports));
  assertEquals(r1.retry, 1); assertEquals(w.rows[0].status, "pending");
  const r2 = await runSweep(deps(w, failing, reports));
  assertEquals(r2.retry, 1);
  const r3 = await runSweep(deps(w, failing, reports));
  assertEquals(r3.failed_final, 1); assertEquals(w.rows[0].status, "failed_final");
  const r4 = await runSweep(deps(w, failing, reports));
  assertEquals(r4.leased, 0); assertEquals(attempts, MAX_ATTEMPTS);       // a broken number cannot ring forever
  assertEquals(reports.map((x) => x.op), ["call_failed", "call_failed", "call_failed_final"]);
  assertEquals(w.rows[0].error, "twilio_http_400_code_21211");            // a fixed code, no number
});

Deno.test("a fault in the database call or in reporting never throws out of the sweep", async () => {
  const boom: SweepDeps = { claimBatch: async () => { throw new Error("db down"); }, place: async () => "x", mark: async () => null, report: async () => { throw new Error("sentry down"); } };
  const r = await runSweep(boom);
  assertEquals(r.error, "claim_batch_failed");
  const w = makeWorld([{ kind: "claim_bidding", source_id: CLAIM, claim_id: CLAIM, state: "IN", is_test: false, qualifies: true }]);
  const markBoom: SweepDeps = { ...deps(w, async () => { throw new CallError("twilio_timeout"); }), mark: async () => { throw new Error("mark failed"); }, report: async () => { throw new Error("sentry down"); } };
  const r2 = await runSweep(markBoom);       // must resolve
  assertEquals(r2.leased, 1);
});

Deno.test("spoken text: event kind, state and claim id, three times, and nothing else", () => {
  const t = buildTwiml({ event_kind: "measurement_paid", state: "oh", claim_id: CLAIM });
  assertEquals((t.match(/<Say /g) ?? []).length, 3);
  assertStringIncludes(t, "Measurement purchase");
  assertStringIncludes(t, '<say-as interpret-as="characters">OH</say-as>');
  assertStringIncludes(t, `<say-as interpret-as="characters">${shortClaimId(CLAIM)}</say-as>`);
  assertEquals(shortClaimId(CLAIM), "00000000");
  const b = buildTwiml({ event_kind: "claim_bidding", state: null, claim_id: CLAIM });
  assertStringIncludes(b, "New claim open for bids"); assertStringIncludes(b, "State unknown");
  const bad = buildTwiml({ event_kind: "claim_bidding", state: "<script>", claim_id: CLAIM });
  assert(!bad.includes("<script>"));   // a malformed state is never spoken or injected
});

Deno.test("placeCall posts one Calls.json request with To/From/Twiml and never logs or returns a number", async () => {
  let seenUrl = ""; let seenBody = ""; let seenAuth = "";
  const fakeFetch = async (url: string, init: RequestInit) => {
    seenUrl = url; seenBody = String(init.body); seenAuth = String((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ sid: "CAabc" }), { status: 201 });
  };
  const sid = await placeCall(CFG, { id: "1", event_kind: "claim_bidding", claim_id: CLAIM, state: "OH", attempts: 1 }, fakeFetch);
  assertEquals(sid, "CAabc");
  assertEquals(seenUrl, "https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls.json");
  const p = new URLSearchParams(seenBody);
  assertEquals(p.get("To"), OWNER_PLACEHOLDER); assertEquals(p.get("From"), FROM_PLACEHOLDER);
  assertStringIncludes(p.get("Twiml") ?? "", "<Response>");
  assert(!(p.get("Twiml") ?? "").includes(OWNER_PLACEHOLDER));      // the number is never spoken
  assertStringIncludes(seenAuth, "Basic ");
});

Deno.test("Twilio errors become fixed codes: HTTP status plus Twilio code, timeout, network; no body, no number", async () => {
  const mk = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const alert = { id: "1", event_kind: "claim_bidding", claim_id: CLAIM, state: "OH", attempts: 1 };
  for (const [fetchFn, expected] of [
    [mk(400, { code: 21211, message: `The 'To' number ${OWNER_PLACEHOLDER} is not valid` }), "twilio_http_400_code_21211"],
    [mk(500, "oops"), "twilio_http_500"],
    [async () => { throw new TypeError(`fetch failed for https://api.twilio.com/ ${OWNER_PLACEHOLDER}`); }, "twilio_network"],
    [async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, "twilio_timeout"],
  ] as Array<[() => Promise<Response>, string]>) {
    try { await placeCall(CFG, alert, fetchFn); assert(false, "should throw"); }
    catch (e) { assert(e instanceof CallError); assertEquals(e.code, expected); assert(!e.message.includes(OWNER_PLACEHOLDER)); }
  }
});

Deno.test("caller gate: service-role key only; anon key, user JWT and no token are refused and no call is placed", () => {
  const SERVICE = "svc-role-key-for-tests";
  assertEquals(authorizeServiceOnly("", SERVICE), { ok: false, status: 401, error: "Authentication required" });
  assertEquals(authorizeServiceOnly("Bearer anon-key-for-tests", SERVICE).ok, false);
  assertEquals((authorizeServiceOnly("Bearer user-jwt-for-tests", SERVICE) as { status: number }).status, 403);
  assertEquals(authorizeServiceOnly(`Bearer ${SERVICE}`, SERVICE), { ok: true });
  assertEquals(authorizeServiceOnly(`Bearer ${SERVICE}`, "").ok, false);   // an unset key never matches an empty token
});

Deno.test("stripe-webhook is untouched: no source file of this function imports or names a payment path", async () => {
  for (const f of ["index.ts", "sweep.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(!/stripe-webhook|create-payment-intent|create-measurement-order/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} references a payment function in code`);
  }
});
