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
import { type AuditRow, type Deps, handle, STAFF_CHANNELS } from "./handler.ts";

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
      if (!open(phone)) supp.push({ id: `s${++seq}`, phone_e164: phone, channel, keyword, released_at: null, released_keyword: null, source_number_id: src });
      return Promise.resolve(true);
    },
    markOptedOut: (c, keyword, channel, at) => {
      writes.push("markOptedOut");
      for (const n of numbers) if (n.contractor_id === c && n.status === "verified") Object.assign(n, { status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: channel });
      return Promise.resolve(true);
    },
    openSuppressions: (phones) => Promise.resolve(supp.filter((s) => phones.includes(s.phone_e164) && s.released_at === null).map(({ id, phone_e164, channel }) => ({ id, phone_e164, channel }))),
    release: (ids, at) => {
      writes.push("release");
      for (const s of supp) if (ids.includes(s.id) && s.released_at === null) Object.assign(s, { released_at: at, released_keyword: "START" });
      return Promise.resolve(true);
    },
    audit: (row) => { writes.push("audit"); audit.push(row); return Promise.resolve(true); },
  });
  return { numbers, supp, audit, writes, client, deps };
}

const adminGate: Deps["gate"] = () => Promise.resolve({ ok: true, user: ADMIN } as GateResult);
const post = (b: unknown) => new Request("https://f.test/admin-sms-optout", { method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: JSON.stringify(b) });
const optOut = (c = C_OUT, channel = "email") => post({ action: "opt_out", contractor_id: c, channel });
const optIn = (c = C_OUT) => post({ action: "opt_in", contractor_id: c, channel: "support_call" });

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
      const res = await handle(post({ action, contractor_id: C_OUT, channel: "email" }), d);
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
  assertEquals(s.writes, ["suppress", "markOptedOut", "audit"]); // suppression row FIRST, as twilio-sms-optout does
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
    { action: "delete", contractor_id: C_OUT, channel: "email" },
    { action: "opt_out", contractor_id: "not-a-uuid", channel: "email" },
    { action: "opt_out", contractor_id: C_OUT, channel: "sms_keyword" }, // staff may not claim the contractor's own channel
    { action: "opt_out", contractor_id: C_OUT },
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

Deno.test("a failing store write is a 500 (retry-safe), never a silent success", async () => {
  const s = makeStore();
  const d = s.deps(adminGate);
  d.suppress = () => Promise.resolve(false);
  assertEquals((await handle(optOut(), d)).status, 500);
  const s2 = makeStore();
  const d2 = s2.deps(adminGate);
  d2.audit = () => Promise.resolve(false);
  const res = await handle(optOut(), d2);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).store_written, true);
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
