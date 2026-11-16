// #3761: admin-sms-optout. Run: deno test supabase/functions/admin-sms-optout/handler.test.ts
// No network, no Twilio, no database, no SMS: every dependency is an in-memory fake.
//
// The in-memory store below MODELS the two live tables and the live SQL function public.contractor_textable_numbers()
// (status verified AND no open suppression row AND not paused; 395-day window; read from the live schema 2026-11-15,
// SELECT only). It is a model test, not a database test: the production function itself is not executed here. The
// senders' own gating code (resolveContractorTextableNumbers, resolveNudgeRecipients) IS the real code under test.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type GateResult } from "../_shared/admin-gate.ts";
import { resolveContractorTextableNumbers, type TextableClient } from "../_shared/contractor-textable.ts";
import { resolveNudgeRecipients } from "../send-contractor-nudge/consent-gate.ts";
import { type AuditRow, cleanReason, type Deps, handle, STAFF_CHANNELS } from "./handler.ts";
import { type Deps as TwilioDeps, handle as twilioHandle, twilioSignature } from "../twilio-sms-optout/handler.ts";

const C_OUT = "11111111-1111-4111-8111-111111111111"; // the contractor staff opt out
const C_IN = "22222222-2222-4222-8222-222222222222"; // a contractor who stays opted in
const PHONE_OUT = "+15155550142";
const PHONE_IN = "+15155550177";
const ADMIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "dustin@otterquote.com" };

interface Num { id: string; contractor_id: string; phone_e164: string; status: string; opt_out_channel?: string | null; opt_out_keyword?: string | null; opted_out_at?: string | null }
interface Supp { id: string; phone_e164: string; channel: string; keyword: string | null; released_at: string | null; released_keyword: string | null; source_number_id: string | null }

function makeStore() {
  const numbers: Num[] = [
    { id: "n-out", contractor_id: C_OUT, phone_e164: PHONE_OUT, status: "verified" },
    { id: "n-in", contractor_id: C_IN, phone_e164: PHONE_IN, status: "verified" },
  ];
  const supp: Supp[] = [];
  const audit: AuditRow[] = [];
  const auditMeta: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let seq = 0;
  const open = (phone: string) => supp.some((s) => s.phone_e164 === phone && s.released_at === null);

  // Model of public.contractor_textable_numbers(uuid).
  const client: TextableClient = {
    rpc: (_fn, args) => Promise.resolve({
      data: numbers.filter((n) => n.contractor_id === args.p_contractor_id && n.status === "verified" && !open(n.phone_e164))
        .map((n) => ({ number_id: n.id, phone_e164: n.phone_e164, is_primary: true })),
      error: null,
    }),
    from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }),
  };

  const deps = (gate: Deps["gate"]): Deps => ({
    gate,
    now: () => new Date("2026-11-15T20:00:00.000Z"),
    listNumbers: (c) => Promise.resolve(numbers.filter((n) => n.contractor_id === c).map(({ id, phone_e164, status }) => ({ id, phone_e164, status }))),
    suppress: (phone, keyword, channel, _at, src) => {
      writes.push("suppress");
      const ex = supp.find((x) => x.phone_e164 === phone && x.released_at === null);
      if (ex) return Promise.resolve(ex.id);
      const id = `s${++seq}`;
      supp.push({ id, phone_e164: phone, channel, keyword, released_at: null, released_keyword: null, source_number_id: src });
      return Promise.resolve(id);
    },
    markOptedOut: (c, keyword, channel, at) => {
      writes.push("markOptedOut");
      const ids: string[] = [];
      for (const n of numbers) if (n.contractor_id === c && n.status === "verified") { Object.assign(n, { status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: channel }); ids.push(n.id); }
      return Promise.resolve(ids);
    },
    openSuppressions: (phones) => Promise.resolve(supp.filter((s) => phones.includes(s.phone_e164) && s.released_at === null).map(({ id, phone_e164, channel }) => ({ id, phone_e164, channel }))),
    release: (ids, at) => {
      writes.push("release");
      const done: string[] = [];
      // mirrors the real write: only rows still open AND still staff-channel are released
      for (const s of supp) if (ids.includes(s.id) && s.released_at === null && STAFF_CHANNELS.includes(s.channel as "email")) { Object.assign(s, { released_at: at, released_keyword: "START" }); done.push(s.id); }
      return Promise.resolve(done);
    },
    auditBegin: (row) => { writes.push("auditBegin"); audit.push(row); auditMeta.push(row.metadata); return Promise.resolve(auditFailsAtBegin ? null : `a${audit.length}`); },
    auditFinish: (id, metadata) => { writes.push("auditFinish"); auditMeta[Number(id.slice(1)) - 1] = metadata; return Promise.resolve(!auditFailsAtFinish); },
  });
  let auditFailsAtBegin = false, auditFailsAtFinish = false;
  // Mirrors the two real deps in twilio-sms-optout/index.ts (suppress 23505 = success; markOptedOut touches verified rows;
  // recordStopOverStaff re-labels staff-channel rows), so the regression test drives the REAL twilio handler.
  const twilioDeps = (): TwilioDeps => ({
    env: (n) => ({ TWILIO_AUTH_TOKEN: "fixture-auth-token", TWILIO_INBOUND_WEBHOOK_URL: "https://x.test/functions/v1/twilio-sms-optout" } as Record<string, string>)[n],
    now: () => new Date("2026-11-15T21:00:00.000Z"),
    suppress: (phone, keyword, at) => {
      if (!open(phone)) supp.push({ id: `s${++seq}`, phone_e164: phone, channel: "sms_keyword", keyword, released_at: null, released_keyword: null, source_number_id: null });
      void at;
      return Promise.resolve(true);
    },
    markOptedOut: (phone, keyword, at) => {
      for (const n of numbers) if (n.phone_e164 === phone && n.status === "verified") Object.assign(n, { status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: "sms_keyword" });
      return Promise.resolve(true);
    },
    hasOpenStop: (phone) => Promise.resolve(open(phone)),
    recordStopOverStaff: (phone, keyword) => {
      for (const x of supp) if (x.phone_e164 === phone && x.released_at === null && STAFF_CHANNELS.includes(x.channel as "email")) Object.assign(x, { channel: "sms_keyword", keyword });
      for (const n of numbers) if (n.phone_e164 === phone && n.status === "opted_out" && STAFF_CHANNELS.includes(n.opt_out_channel as "email")) Object.assign(n, { opt_out_channel: "sms_keyword", opt_out_keyword: keyword });
      return Promise.resolve(true);
    },
    release: () => Promise.resolve(true),
    flag: () => Promise.resolve(true),
  });
  return { numbers, supp, audit, auditMeta, writes, client, deps, twilioDeps, failAudit: (begin: boolean, finish: boolean) => { auditFailsAtBegin = begin; auditFailsAtFinish = finish; } };
}

const adminGate: Deps["gate"] = () => Promise.resolve({ ok: true, user: ADMIN } as GateResult);
const post = (b: unknown) => new Request("https://f.test/admin-sms-optout", { method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: JSON.stringify(b) });
const REASON = "Contractor emailed support on 11/15, ticket 4471";
const optOut = (c = C_OUT, channel = "email") => post({ action: "opt_out", contractor_id: c, channel, reason: REASON });
const optIn = (c = C_OUT) => post({ action: "opt_in", contractor_id: c, channel: "support_call", reason: REASON });

Deno.test("non-admin, anonymous and bad-token callers are refused and NOTHING is written or read", async () => {
  const cases: [string, GateResult, number][] = [
    ["not an admin", { ok: false, status: 403, reason: "not an admin", user: { id: "u", email: "x@example.com" } }, 403],
    ["no token", { ok: false, status: 401, reason: "missing bearer token" }, 401],
    ["invalid token", { ok: false, status: 401, reason: "invalid token" }, 401],
    ["gate error", { ok: false, status: 403, reason: "gate error" }, 403],
  ];
  for (const [label, verdict, status] of cases) {
    for (const action of ["opt_out", "opt_in"]) {
      const s = makeStore();
      let reads = 0;
      const d = s.deps(() => Promise.resolve(verdict));
      const orig = d.listNumbers;
      d.listNumbers = (c) => { reads++; return orig(c); };
      const res = await handle(post({ action, contractor_id: C_OUT, channel: "email", reason: REASON }), d);
      assertEquals(res.status, status, `${label} ${action}`);
      assertEquals(s.writes, [], `${label} ${action}`);
      assertEquals(reads, 0, `${label} ${action}: no read before the gate passes`);
      assertEquals(s.audit.length, 0);
    }
  }
});

Deno.test("admin opt-out writes the store (suppression row + number status) and an audit row naming the actor", async () => {
  const s = makeStore();
  const res = await handle(optOut(C_OUT, "support_call"), s.deps(adminGate));
  assertEquals(res.status, 200);
  assertEquals(s.writes, ["auditBegin", "suppress", "markOptedOut", "auditFinish"]); // audit first, then suppression row FIRST (as twilio-sms-optout does)
  assertEquals(s.supp.length, 1);
  assertEquals(s.supp[0].phone_e164, PHONE_OUT);
  assertEquals(s.supp[0].channel, "support_call");
  assertEquals(s.supp[0].released_at, null);
  const n = s.numbers.find((x) => x.id === "n-out")!;
  assertEquals(n.status, "opted_out");
  assertEquals(n.opt_out_channel, "support_call");
  assertEquals(n.opted_out_at, "2026-11-15T20:00:00.000Z");
  // the other contractor is untouched
  assertEquals(s.numbers.find((x) => x.id === "n-in")!.status, "verified");
  assertEquals(s.audit.length, 1);
  assertEquals(s.audit[0].user_id, ADMIN.id);
  assertEquals(s.audit[0].event_type, "contractor_sms_opt_out_recorded");
  assertEquals(s.audit[0].metadata.actor_email, ADMIN.email);
  assertEquals(s.audit[0].metadata.at, "2026-11-15T20:00:00.000Z");
  assertEquals(s.audit[0].metadata.numbers_last4, ["0142"]); // never the full number
  assertEquals(s.audit[0].metadata.status, "started"); // the intent row, written before the store
  const fin = s.auditMeta[0];
  assertEquals(fin.status, "completed");
  assertEquals(fin.reason, REASON);
  assertEquals(fin.suppression_ids, [s.supp[0].id]); // ids of the rows touched
  assertEquals(fin.opted_out_number_ids, ["n-out"]);
  assertEquals(fin.number_ids, ["n-out"]);
});

Deno.test("opt-out is idempotent: a repeat adds no second open suppression row", async () => {
  const s = makeStore();
  await handle(optOut(), s.deps(adminGate));
  assertEquals((await handle(optOut(), s.deps(adminGate))).status, 200);
  assertEquals(s.supp.filter((x) => x.released_at === null).length, 1);
});

Deno.test("admin opt-in reverses a staff opt-out: the suppression row is released with START; the number must re-verify", async () => {
  const s = makeStore();
  await handle(optOut(), s.deps(adminGate));
  const res = await handle(optIn(), s.deps(adminGate));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.suppressions_released, 1);
  assertEquals(body.numbers_needing_reverification, 1);
  assertEquals(s.supp[0].released_at, "2026-11-15T20:00:00.000Z");
  assertEquals(s.supp[0].released_keyword, "START"); // the table CHECK sms_suppression_release_by_start
  assertEquals(s.numbers.find((x) => x.id === "n-out")!.status, "opted_out"); // consent is NOT re-fabricated
  assertEquals(s.audit.map((a) => a.event_type), ["contractor_sms_opt_out_recorded", "contractor_sms_opt_in_recorded"]);
  assertEquals(s.audit[1].user_id, ADMIN.id);
  assertEquals(s.auditMeta[1].suppression_ids, [s.supp[0].id]); // the released row is attributable to this actor
  assertEquals(s.auditMeta[1].status, "completed");
});

Deno.test("staff cannot release a STOP the contractor texted: 409, nothing released, audited", async () => {
  const s = makeStore();
  s.supp.push({ id: "s-stop", phone_e164: PHONE_OUT, channel: "sms_keyword", keyword: "STOP", released_at: null, released_keyword: null, source_number_id: "n-out" });
  const res = await handle(optIn(), s.deps(adminGate));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "stop_by_text_needs_contractor_start");
  assertEquals(s.supp[0].released_at, null);
  assert(!s.writes.includes("release"));
});

Deno.test("input validation: bad action, bad id, bad channel -> 400 and nothing written", async () => {
  for (const b of [
    { action: "delete", contractor_id: C_OUT, channel: "email", reason: REASON },
    { action: "opt_out", contractor_id: "not-a-uuid", channel: "email", reason: REASON },
    { action: "opt_out", contractor_id: C_OUT, channel: "sms_keyword", reason: REASON }, // staff may not claim the contractor's own channel
    { action: "opt_out", contractor_id: C_OUT, reason: REASON },
    { action: "opt_in", contractor_id: C_OUT, channel: "sms_keyword", reason: REASON }, // opt_in channel is validated too
    { action: "opt_in", contractor_id: C_OUT, reason: REASON },
    { action: "opt_out", contractor_id: C_OUT, channel: "email" }, // reason is required
    { action: "opt_in", contractor_id: C_OUT, channel: "email", reason: "   " },
    { action: "opt_out", contractor_id: C_OUT, channel: "email", reason: "x".repeat(301) },
    { action: "opt_out", contractor_id: C_OUT, channel: "email", reason: "called from 5155550142" },
    { action: "opt_in", contractor_id: C_OUT, channel: "email", reason: "texted from 515-555-0142" },
    { action: "opt_out", contractor_id: C_OUT, channel: "email", reason: 12345 },
  ]) {
    const s = makeStore();
    assertEquals((await handle(post(b), s.deps(adminGate))).status, 400, JSON.stringify(b));
    assertEquals(s.writes, []);
  }
  assertEquals([...STAFF_CHANNELS], ["email", "support_call"]);
  const s = makeStore();
  assertEquals((await handle(optOut("33333333-3333-4333-8333-333333333333"), s.deps(adminGate))).status, 404);
  assertEquals(s.writes, []);
});

Deno.test("audit atomicity: audit is written first (no audit = no store write); a failed store write marks the audit failed", async () => {
  const s0 = makeStore();
  s0.failAudit(true, false);
  assertEquals((await handle(optOut(), s0.deps(adminGate))).status, 500);
  assertEquals(s0.supp.length, 0); // nothing written when the audit cannot be
  assertEquals(s0.numbers[0].status, "verified");

  const s = makeStore();
  const d = s.deps(adminGate);
  d.suppress = () => Promise.resolve(null);
  assertEquals((await handle(optOut(), d)).status, 500);
  assertEquals(s.auditMeta[0].status, "failed");
  assertEquals(s.auditMeta[0].error, "suppress_failed");
  assertEquals(s.auditMeta[0].actor_email, ADMIN.email); // attributed even though the write failed

  const s2 = makeStore();
  s2.failAudit(false, true);
  const res = await handle(optOut(), s2.deps(adminGate));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).store_written, true);
  assertEquals(s2.audit[0].metadata.actor_email, ADMIN.email); // the intent row still names the actor
});

Deno.test("cleanReason", () => {
  assertEquals(cleanReason("  ok reason  "), "ok reason");
  assertEquals(cleanReason("ticket 123456"), "ticket 123456"); // 6 digits is fine
  assertEquals(cleanReason("1234567"), null);
  assertEquals(cleanReason(""), null);
  assertEquals(cleanReason(undefined), null);
});

// ---- REGRESSION (REVIEW 6903556372 blocker 1): staff opt-out -> contractor STOP -> staff opt-in must be 409 ----
Deno.test("REGRESSION: staff opt-out, then the contractor's own STOP, then staff opt-in -> 409 and the row stays suppressed", async () => {
  const s = makeStore();
  assertEquals((await handle(optOut(C_OUT, "email"), s.deps(adminGate))).status, 200);
  assertEquals(s.supp[0].channel, "email");

  // A real signed STOP through the REAL twilio-sms-optout handler, From = the contractor's number.
  const params = { From: PHONE_OUT, Body: "STOP", OptOutType: "STOP" };
  const sig = await twilioSignature("fixture-auth-token", "https://x.test/functions/v1/twilio-sms-optout", params);
  const stop = new Request("https://x.test/functions/v1/twilio-sms-optout", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
    body: new URLSearchParams(params).toString(),
  });
  assertEquals((await twilioHandle(stop, s.twilioDeps())).status, 200);
  assertEquals(s.supp.length, 1); // still ONE open row (the unique index), now owned by the contractor's STOP
  assertEquals(s.supp[0].channel, "sms_keyword");
  assertEquals(s.numbers.find((x) => x.id === "n-out")!.opt_out_channel, "sms_keyword");

  const res = await handle(optIn(C_OUT), s.deps(adminGate));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "stop_by_text_needs_contractor_start");
  assertEquals(s.supp[0].released_at, null);
  assertEquals(s.auditMeta[1].status, "blocked");
  assertEquals(s.auditMeta[1].blocked_suppression_ids, [s.supp[0].id]);
});

Deno.test("RACE: the channel changes between the opt-in's read and its release -> not released, 409 blocked, audit names only released ids", async () => {
  const s = makeStore();
  assertEquals((await handle(optOut(C_OUT, "email"), s.deps(adminGate))).status, 200);
  const d = s.deps(adminGate);
  const realRelease = d.release;
  // A contractor STOP lands after openSuppressions() read channel=email and before the release write.
  d.release = (ids, at) => { s.supp[0].channel = "sms_keyword"; return realRelease(ids, at); };
  const res = await handle(optIn(C_OUT), d);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "stop_by_text_needs_contractor_start");
  assertEquals(s.supp[0].released_at, null);
  assertEquals(s.supp[0].released_keyword, null);
  const meta = s.auditMeta[1];
  assertEquals(meta.status, "blocked");
  assertEquals(meta.suppression_ids, []); // nothing released, so nothing attributed as released
  assertEquals(meta.blocked_suppression_ids, [s.supp[0].id]);
});

// ---- Sender negative control (model test of contractor_textable_numbers(); real sender gating code) ----

Deno.test("NEGATIVE CONTROL: senders skip the staff-opted-out contractor and still text the opted-in one", async () => {
  const s = makeStore();
  const quiet = { log: () => {}, info: () => {} };

  // BEFORE the opt-out both contractors are textable (the control: the gate is not just refusing everything).
  const before = await resolveContractorTextableNumbers(s.client, C_OUT, { site: "notify-contractors/test", ...quiet });
  assertEquals(before.map((r) => r.phone), [PHONE_OUT]);

  assertEquals((await handle(optOut(C_OUT), s.deps(adminGate))).status, 200);

  // notify-contractors / process-dunning / send-contractor-nudge all resolve recipients through this one function.
  const out = await resolveContractorTextableNumbers(s.client, C_OUT, { site: "notify-contractors/test", ...quiet });
  const inn = await resolveContractorTextableNumbers(s.client, C_IN, { site: "notify-contractors/test", ...quiet });
  assertEquals(out, []);
  assertEquals(inn.map((r) => r.phone), [PHONE_IN]);

  // send-contractor-nudge's own gate (is_test=true so the TCR release gate passes and only the opt-out decides).
  assertEquals(await resolveNudgeRecipients(s.client, C_OUT, true, { log: () => {} }), []);
  assertEquals(await resolveNudgeRecipients(s.client, C_IN, true, { log: () => {} }), [PHONE_IN]);

  // Reversal releases the suppression row, but the number is still opted_out, so it stays unsendable until re-verified.
  assertEquals((await handle(optIn(C_OUT), s.deps(adminGate))).status, 200);
  assertEquals(await resolveNudgeRecipients(s.client, C_OUT, true, { log: () => {} }), []);
  // ...and once the contractor re-verifies (modelled as the verified row coming back) the number is textable again.
  s.numbers.push({ id: "n-out-2", contractor_id: C_OUT, phone_e164: PHONE_OUT, status: "verified" });
  assertEquals(await resolveNudgeRecipients(s.client, C_OUT, true, { log: () => {} }), [PHONE_OUT]);
});
