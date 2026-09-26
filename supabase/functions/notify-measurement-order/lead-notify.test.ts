// deno test --allow-read=. supabase/functions/notify-measurement-order/lead-notify.test.ts
// gh-2121 (HO-3) / PR #2226 REVIEW D6: the lead_order / lead_upload branch.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildLeadEmail,
  handleLeadNotification,
  type LeadInfo,
  type LeadNotifyDeps,
  type LeadRecord,
  parseLeadNotifyBody,
} from "./lead-notify.ts";

const ORDER_ID = "11111111-0000-4000-8000-000000000001";
const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function order(over: Partial<LeadRecord> = {}): LeadRecord {
  return { id: ORDER_ID, lead_id: LEAD_ID, is_test: false, admin_notified_at: null, created_at: "2026-09-26T20:00:00Z", homeowner_charge_amount: 1500, stripe_payment_intent_id: "pi_1", ...over };
}
function lead(over: Partial<LeadInfo> = {}): LeadInfo {
  return { email: "jane@example.com", name: "Jane", phone: "3175550100", property_address: "1 Main St, Zionsville, IN", is_synthetic: false, ...over };
}

function deps(rec: LeadRecord | null, l: LeadInfo | null, over: Partial<LeadNotifyDeps> = {}) {
  const state = { notified: rec?.admin_notified_at ?? null as string | null, sends: 0, alerts: [] as string[], released: 0 };
  const d: LeadNotifyDeps = {
    verifySend: false,
    loadRecord: () => Promise.resolve(rec ? { ...rec, admin_notified_at: state.notified } : null),
    loadLead: () => Promise.resolve(l),
    claimNotified: () => {
      if (state.notified) return Promise.resolve(false);
      state.notified = "now";
      return Promise.resolve(true);
    },
    releaseNotified: () => { state.notified = null; state.released++; return Promise.resolve(); },
    sendEmail: () => { state.sends++; return Promise.resolve({ ok: true, id: "mg_1" }); },
    alert: (_t, m) => { state.alerts.push(m); return Promise.resolve(); },
    ...over,
  };
  return { d, state };
}

Deno.test("parseLeadNotifyBody routes lead_order / lead_upload and leaves the claim-path body alone", () => {
  assertEquals(parseLeadNotifyBody({ lead_order: true, order_id: ORDER_ID }), { kind: "order", id: ORDER_ID });
  assertEquals(parseLeadNotifyBody({ lead_upload: true, upload_id: ORDER_ID }), { kind: "upload", id: ORDER_ID });
  assertEquals(parseLeadNotifyBody({ order_id: ORDER_ID }), null, "a hover_orders call still goes down the original path");
  assert("error" in (parseLeadNotifyBody({ lead_order: true, order_id: "x" }) as object));
});

Deno.test("D6: a paid lead order sends ONE admin email (it used to 404)", async () => {
  const { d, state } = deps(order(), lead());
  const r = await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  assertEquals(r.status, 200);
  assertEquals(state.sends, 1);
});

Deno.test("D6: a second call (browser + webhook both notifying) does not send a second email", async () => {
  const { d, state } = deps(order(), lead());
  await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  const r2 = await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  assertEquals(r2.body.reason, "already_notified");
  assertEquals(state.sends, 1);
});

Deno.test("D6: a failed send releases the claim and alerts, so a retry can send", async () => {
  const { d, state } = deps(order(), lead(), { sendEmail: () => Promise.resolve({ ok: false }) });
  const r = await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  assertEquals(r.status, 502);
  assertEquals(state.released, 1);
  assertEquals(state.alerts.length, 1);
  assertEquals(state.notified, null);
});

Deno.test("D11: synthetic lead / is_test row / internal test email are skipped unless X-Verify-Send", async () => {
  for (const [rec, l] of [[order({ is_test: true }), lead()], [order(), lead({ is_synthetic: true })], [order(), lead({ email: "q@otterquote-internal.test" })]] as Array<[LeadRecord, LeadInfo]>) {
    const { d, state } = deps(rec, l);
    const r = await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
    assertEquals(r.body.reason, "test_account");
    assertEquals(state.sends, 0);
  }
  const { d, state } = deps(order({ is_test: true }), lead(), { verifySend: true });
  await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  assertEquals(state.sends, 1, "NEGATIVE CONTROL: X-Verify-Send lifts the skip");
});

Deno.test("an unknown order id is 404 and sends nothing", async () => {
  const { d, state } = deps(null, lead());
  const r = await handleLeadNotification({ kind: "order", id: ORDER_ID }, d);
  assertEquals(r.status, 404);
  assertEquals(state.sends, 0);
});

Deno.test("D6: a loss-sheet upload also notifies the admin", async () => {
  const rec = { id: ORDER_ID, lead_id: LEAD_ID, is_test: false, admin_notified_at: null, created_at: null, content_type: "application/pdf", byte_size: 1234, storage_path: `${LEAD_ID}/1-upload.pdf` };
  const { d, state } = deps(rec, lead());
  const r = await handleLeadNotification({ kind: "upload", id: ORDER_ID }, d);
  assertEquals(r.status, 200);
  assertEquals(state.sends, 1);
});

Deno.test("the email carries the address, the amount and the D-237 postal footer, and escapes HTML", () => {
  const m = buildLeadEmail("order", order(), lead({ property_address: "<b>1 Main</b>" }));
  assert(m.subject.startsWith("Buy basic report — "));
  assert(m.text.includes("$15.00"));
  assert(m.html.includes("&lt;b&gt;1 Main&lt;/b&gt;"));
  assert(!m.html.includes("<b>1 Main</b>"));
});
