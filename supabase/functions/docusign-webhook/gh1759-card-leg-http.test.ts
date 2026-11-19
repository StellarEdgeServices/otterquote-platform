// gh-1759 (Refs #1759): the CARD LEG of claims.platform_fee_stripe_id, proven through the real docusign-webhook REQUEST HANDLER.
//
// What the fix claims: when a signed "Completed" event arrives for a claim whose contractor is charged by card, docusign-webhook
// calls create-payment-intent and writes the returned Stripe CHARGE id to claims.platform_fee_stripe_id, so that a later
// charge.dispute.created (which carries that charge id) can be traced to its claim. fee-charge-writer.test.ts only reads index.ts as
// text; nothing ran the handler. This file runs it: signature check -> claim lookup -> ack/price gates -> live-charge guard ->
// fetch to create-payment-intent -> the claims update.
//
// Technique (same idea as stripe-webhook/gh3510-refund-failed-http.test.ts, one difference): index.ts registers its handler with
// serve() from std@0.177.0, which is a Deno.listen + Deno.serveHttp server, not Deno.serve. Deno 2 has no Deno.serveHttp, and the
// handler is a private field of std's Server. So the test (1) stubs Deno.listen / Deno.serveHttp for the import, so the REAL std
// Server hands every request it is given to the REAL handler, (2) stubs Deno.env.get (CI runs `deno test` without --allow-env),
// and (3) replaces globalThis.fetch with an in-memory fake of PostgREST (what supabase-js talks to), the BoldSign document API and
// the sibling Edge Functions. No network, no real secrets, nothing in index.ts is changed. A call to any host the fake does not
// know is recorded and fails the test.
//
// NOT proven here: that Stripe's real API returns what the fake create-payment-intent returns, and that the deployed function
// matches this source. See the PR body.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const HMAC_SECRET = "whsec_test_gh1759_throwaway_not_a_real_secret";
const SB_URL = "https://fake-gh1759.supabase.test";
const SERVICE_KEY = "fake-service-role-key-gh1759";
const TEST_ENV: Record<string, string> = {
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  BOLDSIGN_WEBHOOK_HMAC_SECRET: HMAC_SECRET,
  BOLDSIGN_REQUIRE_SIGNATURE: "true",
  BOLDSIGN_API: "fake-boldsign-key-gh1759",
};
// deno-lint-ignore no-explicit-any
(Deno.env as any).get = (k: string) => (k in TEST_ENV ? TEST_ENV[k] : undefined);

// ---- capture the handler by driving std's Server through a fake listener ------------------------------------------
// deno-lint-ignore no-explicit-any
const denoAny = Deno as any;
interface ReqEvent { request: Request; respondWith: (r: Response) => Promise<void> }
const queued: ReqEvent[] = [];
let waiting: ((e: ReqEvent) => void) | undefined;
let httpConnServed: () => void;
const served = new Promise<void>((r) => (httpConnServed = r));
const realListen = denoAny.listen;
const realServeHttp = denoAny.serveHttp;
denoAny.listen = () => {
  let accepted = false;
  const addr = { transport: "tcp", hostname: "127.0.0.1", port: 8000 };
  return {
    addr,
    accept: () => accepted ? new Promise(() => {}) : (accepted = true, Promise.resolve({ localAddr: addr, remoteAddr: addr, close() {} })),
    close() {},
  };
};
denoAny.serveHttp = () => {
  httpConnServed();
  return {
    nextRequest: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<ReqEvent>((r) => (waiting = r)),
    close() {},
  };
};
const realLog = console.log;
console.log = () => {}; // std's serve() prints "Listening on ..."
try {
  // Non-literal specifier on purpose: index.ts has pre-existing type errors under `deno check`, and a literal import would make
  // `deno test` type-check it and fail before any test runs. Supabase does not type-check at deploy.
  await import(new URL("./index.ts", import.meta.url).href);
  await served;
} finally {
  console.log = realLog;
  denoAny.listen = realListen;
  denoAny.serveHttp = realServeHttp;
}
function send(request: Request): Promise<Response> {
  return new Promise((resolve) => {
    const ev: ReqEvent = { request, respondWith: (r) => { resolve(r); return Promise.resolve(); } };
    if (waiting) { const w = waiting; waiting = undefined; w(ev); } else queued.push(ev);
  });
}

// ---- in-memory fake of everything index.ts talks to ----------------------------------------------------------------
type Row = Record<string, unknown>;
interface CpiAnswer { status: number; body: unknown }
interface Scenario { claim: Row; quote: Row; contractor: Row; cpi: CpiAnswer }
interface Write { method: string; table: string; query: string; body: Row }
interface Call { fn: string; method: string; body: Row | null; auth: string | null }
interface Db { sc: Scenario; writes: Write[]; calls: Call[]; unexpected: string[]; fetchCalls: number }

const ENVELOPE = "env-gh1759-1";
const baseScenario = (over: Partial<Scenario> = {}): Scenario => ({
  claim: {
    id: "claim-1759", status: "contract_pending", docusign_envelope_id: ENVELOPE, color_confirmation_envelope_id: null,
    project_confirmation_envelope_id: null, contract_signed_at: null, is_test: false, live_charge_authorized_at: null,
    user_id: "user-1", property_address: "1 Test St",
  },
  quote: {
    id: "quote-1759", claim_id: "claim-1759", contractor_id: "contractor-1759", status: "selected", total_price: 4000,
    platform_fee_pct: 5, decking_price_per_sheet: null, payment_status: "succeeded", contractor_signed_at: null, homeowner_signed_at: null,
  },
  contractor: { id: "contractor-1759", stripe_customer_id: "cus_fake_1", stripe_payment_method_id: "pm_fake_1", company_name: "Fake Roofing" },
  // create-payment-intent's card-success answer: 5% of $4,000 = $200.00 = 20000 cents.
  cpi: { status: 200, body: { succeeded: true, status: "succeeded", payment_intent_id: "pi_card_1", charge_id: "ch_card_1", platform_fee_cents: 20000 } },
  ...over,
});
const newDb = (over: Partial<Scenario> = {}): Db => ({ sc: baseScenario(over), writes: [], calls: [], unexpected: [], fetchCalls: 0 });

function json(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// BoldSign GET /v1/document/properties: both signers completed; the contract_price and acknowledgment fields are satisfied.
function boldsignProperties() {
  return {
    signerDetails: [
      { id: "sig-c", status: "Completed", signerEmail: "c@example.test", formFields: [
        { id: "otterquote_acknowledgment", value: "true" }, { id: "contract_price", value: "$4,000.00" },
      ] },
      { id: "sig-h", status: "Completed", signerEmail: "h@example.test", formFields: [] },
    ],
  };
}
function installFakeFetch(db: Db) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    db.fetchCalls++;
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    return (async () => {
      if (url.origin === "https://api.boldsign.com") {
        if (url.pathname === "/v1/document/properties") return json(boldsignProperties());
      }
      if (url.origin === SB_URL && url.pathname.startsWith("/functions/v1/")) {
        const fn = url.pathname.replace("/functions/v1/", "");
        const raw = await req.text();
        db.calls.push({ fn, method: req.method, body: raw ? JSON.parse(raw) : null, auth: req.headers.get("authorization") });
        return fn === "create-payment-intent" ? json(db.sc.cpi.body, db.sc.cpi.status) : json({ ok: true });
      }
      if (url.origin === SB_URL && url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.replace("/rest/v1/", "");
        const accept = req.headers.get("accept") ?? "";
        const prefer = req.headers.get("prefer") ?? "";
        const wantsObject = accept.includes("vnd.pgrst.object");
        if (req.method === "GET") {
          const rows: Row[] = table === "claims" ? [db.sc.claim]
            : table === "quotes" ? [db.sc.quote]
            : table === "contractors" ? [db.sc.contractor]
            : table === "platform_settings" ? [{ value: 5 }]
            : table === "profiles" ? [{ full_name: "Fake Homeowner" }]
            : []; // notifications, everything else: nothing found
          return wantsObject ? (rows.length ? json(rows[0]) : json({ code: "PGRST116", message: "no rows", details: "", hint: "" }, 406)) : json(rows);
        }
        const raw = await req.text();
        db.writes.push({ method: req.method, table, query: url.search, body: raw ? JSON.parse(raw) : {} });
        if (req.method === "PATCH") return prefer.includes("return=representation") ? json([{ id: "row-1" }]) : new Response(null, { status: 204 });
        return json(null, 201); // POST (insert without select)
      }
      db.unexpected.push(`${req.method} ${url.origin}${url.pathname}`);
      return json({ error: "unexpected host in test" }, 599);
    })();
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

// ---- request helpers -----------------------------------------------------------------------------------------------
async function hmacHex(body: string, ts: string, secret = HMAC_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sign(body: string, secret = HMAC_SECRET) {
  const ts = String(Math.floor(Date.now() / 1000));
  return `t=${ts},s0=${await hmacHex(body, ts, secret)}`;
}
function completedEvent(documentId = ENVELOPE) {
  return JSON.stringify({
    event: { eventType: "Completed", created: 1760000000 },
    data: {
      documentId, status: "Completed",
      signerDetails: [
        { id: "sig-c", status: "Completed", signerEmail: "c@example.test", order: 1 },
        { id: "sig-h", status: "Completed", signerEmail: "h@example.test", order: 2 },
      ],
    },
  });
}
function post(body: string, sig: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["x-boldsign-signature"] = sig;
  return new Request(`${SB_URL}/functions/v1/docusign-webhook`, { method: "POST", body, headers });
}
async function run(db: Db, req: Request) {
  const restore = installFakeFetch(db);
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {}; // keep the handler's logs out of test output
  try { return await send(req); } finally { console.log = log; console.error = err; console.warn = warn; restore(); }
}
async function signedCompleted(db: Db) {
  const body = completedEvent();
  return await run(db, post(body, await sign(body)));
}
const claimPatches = (db: Db) => db.writes.filter((w) => w.table === "claims" && w.method === "PATCH");
const feeIdWrites = (db: Db) => claimPatches(db).filter((w) => "platform_fee_stripe_id" in w.body);
const alertTypes = (db: Db) => db.writes.filter((w) => w.table === "platform_alerts_log").map((w) => w.body.alert_type);
const callsTo = (db: Db, fn: string) => db.calls.filter((c) => c.fn === fn);

// ---- tests ---------------------------------------------------------------------------------------------------------
Deno.test("gh-1759 card leg: a correctly signed Completed event for a card-paying, non-test claim calls create-payment-intent once and writes the returned charge id to claims.platform_fee_stripe_id in exactly one update", async () => {
  const db = newDb();
  const res = await signedCompleted(db);
  assertEquals(res.status, 200);
  const out = await res.json();
  assertEquals(out.claim_id, "claim-1759");
  assertEquals(out.updated, true);

  const cpi = callsTo(db, "create-payment-intent");
  assertEquals(cpi.length, 1);
  assertEquals(cpi[0].auth, `Bearer ${SERVICE_KEY}`);
  assertEquals(cpi[0].body?.amount, 20000); // 5% of $4,000.00, whole cents (platformFeeCents)
  assertEquals(cpi[0].body?.contractor_id, "contractor-1759");
  assertEquals(cpi[0].body?.off_session, true);
  assertEquals((cpi[0].body?.metadata as Row).claim_id, "claim-1759");

  const writes = feeIdWrites(db);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].query.includes("id=eq.claim-1759"), true);
  assertEquals(writes[0].body.platform_fee_stripe_id, "ch_card_1"); // the CHARGE id, which is what dispute.charge carries
  assert(writes[0].body.platform_fee_stripe_id !== "pi_card_1");
  assertEquals(writes[0].body.platform_fee_charged, true);
  assertEquals(writes[0].body.status, "contract_signed");
  assertEquals(writes[0].body.platform_fee_amount, 200);
  assertEquals(db.unexpected, []);
});

Deno.test("gh-1759 card leg: the same event with a bad signature is rejected with 401 and writes nothing and calls nothing", async () => {
  const body = completedEvent();
  const good = await sign(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const variants: [string, string | null][] = [
    ["wrong secret", await sign(body, "some_other_secret")],
    ["tampered digest", good.replace(/.$/, (c) => (c === "0" ? "1" : "0"))],
    ["digest of a different body", `t=${ts},s0=${await hmacHex(completedEvent("env-other"), ts)}`],
    ["unparseable header", "garbage"],
    ["no header", null],
  ];
  for (const [label, sig] of variants) {
    const db = newDb();
    const res = await run(db, post(body, sig));
    assertEquals(res.status, 401, label);
    assertEquals(db.writes, [], label);
    assertEquals(db.calls, [], label);
    assertEquals(db.fetchCalls, 0, label); // rejected before any database, BoldSign or payment call
  }
  // With the fail-closed flag off, a configured secret still rejects a wrong signature.
  TEST_ENV.BOLDSIGN_REQUIRE_SIGNATURE = "false";
  try {
    const db = newDb();
    assertEquals((await run(db, post(body, await sign(body, "some_other_secret")))).status, 401);
    assertEquals(db.writes, []);
    assertEquals(db.fetchCalls, 0);
  } finally {
    TEST_ENV.BOLDSIGN_REQUIRE_SIGNATURE = "true";
  }
});

Deno.test("gh-1759 card leg: an is_test claim with no live_charge_authorized_at is refused by the live-charge guard: no payment call, no fee id, the signing is still recorded", async () => {
  const db = newDb({ claim: { ...baseScenario().claim, is_test: true, live_charge_authorized_at: null } });
  const res = await signedCompleted(db);
  assertEquals(res.status, 200);
  const out = await res.json();
  assertEquals(out.platform_fee_charged, false);
  assertEquals(out.fee_charge_refused, "test_claim_unauthorized");
  assertEquals(callsTo(db, "create-payment-intent"), []); // no Stripe call was even attempted
  assertEquals(callsTo(db, "process-dunning"), []); // a refusal is not a retry
  assertEquals(feeIdWrites(db), []);
  // What it does record: contract_signed on the claim, a platform_alerts_log row, an activity_log row.
  const signedPatch = claimPatches(db).filter((w) => w.body.status === "contract_signed");
  assertEquals(signedPatch.length, 1);
  assertEquals("platform_fee_charged" in signedPatch[0].body, false);
  assert(alertTypes(db).includes("platform_fee_refused_unauthorized_test"));
  assertEquals(db.writes.filter((w) => w.table === "activity_log").map((w) => w.body.event_type), ["platform_fee_refused_unauthorized_test"]);
  assertEquals(db.unexpected, []);
});

Deno.test("gh-1759 card leg: control for the guard: an is_test claim WITH live_charge_authorized_at passes the guard and reaches create-payment-intent", async () => {
  const db = newDb({ claim: { ...baseScenario().claim, is_test: true, live_charge_authorized_at: "2026-11-01T00:00:00Z" } });
  const res = await signedCompleted(db);
  assertEquals(res.status, 200);
  assertEquals(callsTo(db, "create-payment-intent").length, 1);
  assertEquals(feeIdWrites(db).length, 1);
});

Deno.test("gh-1759 ACH: when create-payment-intent answers pending (ACH processing) docusign-webhook writes NO claims.platform_fee_stripe_id; the ACH id is written later by stripe-webhook payment_intent.succeeded", async () => {
  // docusign-webhook does not choose card or ACH: create-payment-intent decides and answers succeeded or pending. An ACH PaymentIntent
  // has no charge id yet, so this handler records only the signing and the PaymentIntent id on the quote. The writer for the ACH id is
  // stripe-webhook's payment_intent.succeeded handler (stripe-webhook/index.ts, "gh-1759"); it is not part of this handler.
  const db = newDb({ cpi: { status: 200, body: { succeeded: false, pending: true, status: "processing", payment_intent_id: "pi_ach_1" } } });
  const res = await signedCompleted(db);
  assertEquals(res.status, 200);
  assertEquals(callsTo(db, "create-payment-intent").length, 1);
  assertEquals(feeIdWrites(db), []);
  const signed = claimPatches(db).filter((w) => w.body.status === "contract_signed");
  assertEquals(signed.length, 1);
  assertEquals("platform_fee_charged" in signed[0].body, false); // not marked charged until settlement
  const quotePatch = db.writes.filter((w) => w.table === "quotes" && w.body.payment_status === "pending");
  assertEquals(quotePatch.length, 1);
  assertEquals(quotePatch[0].body.payment_intent_id, "pi_ach_1");
  assert(alertTypes(db).includes("payment_pending_ach"));
});

Deno.test("gh-1759 card leg: when create-payment-intent fails (500) no fee id is written; the claim is marked signed, the quote goes to dunning, process-dunning is called once, and payment_failed_hard is alerted", async () => {
  const db = newDb({ cpi: { status: 500, body: { error: "stripe api error" } } });
  const res = await signedCompleted(db);
  assertEquals(res.status, 200); // 200 so BoldSign does not retry
  const out = await res.json();
  assertEquals(out.payment_failed, true);
  assertEquals(out.message, "Contract signed but payment failed. Dunning initiated.");
  assertEquals(callsTo(db, "create-payment-intent").length, 1);
  assertEquals(feeIdWrites(db), []);
  assertEquals(claimPatches(db).filter((w) => w.body.platform_fee_charged === true), []);
  const signed = claimPatches(db).filter((w) => w.body.status === "contract_signed");
  assertEquals(signed.length, 1);
  assertEquals(db.writes.filter((w) => w.table === "quotes" && w.body.payment_status === "dunning").length, 1);
  assertEquals(db.writes.filter((w) => w.table === "payment_failures").length, 1);
  assert(alertTypes(db).includes("payment_failed_hard"));
  assertEquals(callsTo(db, "process-dunning").length, 1);
  assertEquals(callsTo(db, "notify-contractors"), []); // the contractor is notified only after a successful charge
});

Deno.test("gh-1759 card leg: when create-payment-intent says succeeded but returns no charge_id, the fee is marked charged and NO fee id is written, and nothing alerts (current behaviour, pinned so a change is deliberate)", async () => {
  // The writer is conditional: `if (typeof paymentResult.charge_id === "string" && paymentResult.charge_id)`. If Stripe's latest_charge
  // were ever absent on a succeeded card PaymentIntent, claims.platform_fee_charged becomes true with platform_fee_stripe_id NULL, which
  // is the dispute-lookup gap #1759 was filed about, and no alert row says so.
  const db = newDb({ cpi: { status: 200, body: { succeeded: true, status: "succeeded", payment_intent_id: "pi_card_2", platform_fee_cents: 20000 } } });
  const res = await signedCompleted(db);
  assertEquals(res.status, 200);
  assertEquals(feeIdWrites(db), []);
  const charged = claimPatches(db).filter((w) => w.body.platform_fee_charged === true);
  assertEquals(charged.length, 1);
  assertEquals(alertTypes(db).filter((t) => String(t).includes("fee")), []);
});
