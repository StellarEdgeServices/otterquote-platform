// gh-1759 (Refs #1759): the DISPUTE side of claims.platform_fee_stripe_id, through the real stripe-webhook REQUEST HANDLER.
//
// docusign-webhook/gh1759-card-leg-http.test.ts proves the writer stores the Stripe CHARGE id (here "ch_card_1", the same literal) on
// the claim. This file proves the reader: a signed charge.dispute.created whose `charge` equals claims.platform_fee_stripe_id is
// resolved to that claim and a small dispute is NOT sent down the unresolved path; with the id absent, the same dispute is unresolved,
// raises dispute_claim_unresolved, and goes to the manual queue. fee-charge-writer.test.ts / dispute-routing.test.ts check the source
// text and the pure routing function; neither runs the handler.
//
// Same technique as gh3510-refund-failed-http.test.ts: capture the handler by stubbing Deno.serve during the import, stub Deno.env.get,
// fake globalThis.fetch in memory, sign with a throwaway secret. No network, nothing in index.ts changed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const TEST_SECRET = "whsec_test_gh1759_dispute_throwaway_not_a_real_secret";
const SB_URL = "https://fake-gh1759-dispute.supabase.test";
const TEST_ENV: Record<string, string> = {
  STRIPE_WEBHOOK_SIGNING_SECRET: TEST_SECRET,
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key-gh1759-dispute",
  STRIPE_SECRET_KEY_TEST: "sk_test_fake_gh1759_not_a_real_key", // livemode:false events read this key; it only goes to the in-memory fake
};

// deno-lint-ignore no-explicit-any
const denoAny = Deno as any;
const realServe = denoAny.serve;
let handler: ((req: Request) => Promise<Response>) | undefined;
denoAny.serve = (...args: unknown[]) => {
  handler = args.find((a) => typeof a === "function") as typeof handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
};
// deno-lint-ignore no-explicit-any
(Deno.env as any).get = (k: string) => (k in TEST_ENV ? TEST_ENV[k] : undefined);
try {
  // Non-literal specifier: index.ts has pre-existing type errors under `deno check`; see gh3510-refund-failed-http.test.ts.
  await import(new URL("./index.ts", import.meta.url).href);
} finally {
  denoAny.serve = realServe;
}
assert(handler, "index.ts did not register a Deno.serve handler");
const handle = handler!;

type Row = Record<string, unknown>;
interface Db {
  claims: Row[]; // the claims table of the fake
  ledger: string[];
  writes: { method: string; table: string; body: Row }[];
  reads: { table: string; query: string }[];
  stripeCalls: string[];
  unexpected: string[];
}
const CLAIM = { id: "claim-1759", user_id: "user-1", platform_fee_stripe_id: "ch_card_1", platform_fee_amount: 200, selected_contractor_id: "contractor-1759",
  contract_signed_at: "2026-11-01T00:00:00Z", completion_date: null, homeowner_name: "Fake Homeowner", property_address: "1 Test St", is_test: false };
const newDb = (claims: Row[]): Db => ({ claims, ledger: [], writes: [], reads: [], stripeCalls: [], unexpected: [] });

function json(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function installFakeFetch(db: Db) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    return (async () => {
      if (url.origin === "https://api.stripe.com") { // postDisputeEvidence (draft save); answered by the fake, never the real API
        db.stripeCalls.push(`${req.method} ${url.pathname}`);
        return json({ id: url.pathname.split("/").pop(), object: "dispute", status: "needs_response" });
      }
      if (url.origin !== SB_URL) { db.unexpected.push(`${req.method} ${url.origin}${url.pathname}`); return json({}, 599); }
      const table = url.pathname.replace("/rest/v1/", "");
      const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
      if (req.method === "GET") {
        db.reads.push({ table, query: url.search });
        let rows: Row[] = [];
        if (table === "claims") { // honour the two filters the dispute code uses, so a missing id really finds nothing
          const fee = url.searchParams.get("platform_fee_stripe_id");
          const id = url.searchParams.get("id");
          rows = db.claims.filter((c) => (fee ? `eq.${c.platform_fee_stripe_id}` === fee : true) && (id ? `eq.${c.id}` === id : true));
        }
        return wantsObject ? (rows.length ? json(rows[0]) : json({ code: "PGRST116", message: "no rows", details: "", hint: "" }, 406)) : json(rows);
      }
      const raw = await req.text();
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && table === "stripe_webhook_events") {
        if (db.ledger.includes(body.event_id)) return json({ code: "23505", message: "duplicate key", details: "", hint: "" }, 409);
        db.ledger.push(body.event_id);
        return json(null, 201);
      }
      db.writes.push({ method: req.method, table, body });
      if (req.method === "POST") return wantsObject ? json({ id: `${table}-row-1` }, 201) : json(null, 201);
      if (req.method === "PATCH") return json([{ id: `${table}-row-1` }]);
      return json(null, 204);
    })();
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = TEST_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
  return `t=${ts},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function disputeEvent(opts: { eventId: string; charge: string; amount?: number }) {
  return JSON.stringify({
    id: opts.eventId, object: "event", type: "charge.dispute.created", livemode: false,
    data: { object: {
      id: `dp_${opts.eventId}`, object: "dispute", amount: opts.amount ?? 17500, currency: "usd", charge: opts.charge, payment_intent: null,
      reason: "fraudulent", status: "needs_response", livemode: false, metadata: {},
      evidence_details: { due_by: 1770000000, has_evidence: false, past_due: false, submission_count: 0 },
    } },
  });
}
async function run(db: Db, body: string) {
  const restore = installFakeFetch(db);
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    return await handle(new Request(`${SB_URL}/functions/v1/stripe-webhook`, {
      method: "POST", body, headers: { "stripe-signature": await sign(body), "content-type": "application/json" },
    }));
  } finally { console.log = log; console.error = err; console.warn = warn; restore(); }
}
const alertTypes = (db: Db) => db.writes.filter((w) => w.table === "platform_alerts_log").map((w) => w.body.alert_type);
const disputeRows = (db: Db) => db.writes.filter((w) => w.table === "disputes" && w.method === "POST");

Deno.test("gh-1759 dispute lookup: a signed charge.dispute.created whose charge equals claims.platform_fee_stripe_id resolves to that claim (sub-$500: auto-evidence path, no unresolved alert)", async () => {
  const db = newDb([{ ...CLAIM }]);
  const res = await run(db, disputeEvent({ eventId: "evt_1759_found", charge: "ch_card_1" }));
  assertEquals(res.status, 200);
  assert(db.reads.some((r) => r.table === "claims" && r.query.includes("platform_fee_stripe_id=eq.ch_card_1")), "handler did not look the claim up by platform_fee_stripe_id");
  const rows = disputeRows(db);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].body.claim_id, "claim-1759");
  assertEquals(rows[0].body.stripe_charge_id, "ch_card_1");
  assertEquals(rows[0].body.routing, "auto_submit");
  assertEquals(alertTypes(db).includes("dispute_claim_unresolved"), false);
  assertEquals(db.stripeCalls.length, 1); // evidence was saved (draft) against the dispute, via the fake Stripe host
  assertEquals(db.unexpected, []);
});

Deno.test("gh-1759 dispute lookup control: the same dispute when no claim carries the charge id is unresolved: claim_id null, dispute_claim_unresolved alert, manual queue, no evidence sent", async () => {
  const db = newDb([{ ...CLAIM, platform_fee_stripe_id: null }]); // the pre-fix state: the claim exists but nothing wrote the id
  const res = await run(db, disputeEvent({ eventId: "evt_1759_absent", charge: "ch_card_1" }));
  assertEquals(res.status, 200);
  const rows = disputeRows(db);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].body.claim_id, null);
  assertEquals(rows[0].body.routing, "manual_queue");
  assert(alertTypes(db).includes("dispute_claim_unresolved"));
  assertEquals(db.writes.filter((w) => w.table === "admin_dispute_queue").length, 1);
  assertEquals(db.stripeCalls, []); // nothing was submitted to Stripe: the one-shot submission is preserved
  assertEquals(db.unexpected, []);
});

Deno.test("gh-1759 dispute lookup: a different charge id does not match another claim's id", async () => {
  const db = newDb([{ ...CLAIM }]);
  const res = await run(db, disputeEvent({ eventId: "evt_1759_other", charge: "ch_someone_else" }));
  assertEquals(res.status, 200);
  assertEquals(disputeRows(db)[0].body.claim_id, null);
  assert(alertTypes(db).includes("dispute_claim_unresolved"));
});
