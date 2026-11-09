// gh-3510: a switch refund that fails after creation is recorded and alerted once; retries and other statuses do nothing.
// No Stripe, Mailgun or database call is made: the Supabase client is an in-memory fake.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleSwitchRefundFailed } from "./refund-failed.ts";
import { stripComments } from "./test-source-utils.ts";

function fakeSb(opts: { lookupError?: boolean } = {}) {
  const alerts: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const sb = {
    from(table: string) {
      const q: { filters: [string, string][] } = { filters: [] };
      const b = {
        select: () => b,
        eq: (_c: string, _v: string) => b,
        like: (_c: string, v: string) => { q.filters.push(["like", v]); return b; },
        limit: () => {
          if (opts.lookupError) return Promise.resolve({ data: null, error: { message: "boom" } });
          const needle = (q.filters[0]?.[1] ?? "").replaceAll("%", "");
          return Promise.resolve({ data: alerts.filter((a) => String(a.message).includes(needle)).map(() => ({ id: "x" })), error: null });
        },
        maybeSingle: () => Promise.resolve({ data: table === "quotes" ? { id: "q-1", claim_id: "c-1" } : null, error: null }),
        insert: (row: Record<string, unknown>) => { writes.push(`insert:${table}`); if (table === "platform_alerts_log") alerts.push(row); return Promise.resolve({ error: null }); },
        update: () => { writes.push(`update:${table}`); return b; },
        delete: () => { writes.push(`delete:${table}`); return b; },
      };
      return b;
    },
  };
  return { sb, alerts, writes };
}

const failedRefund = { id: "re_1", status: "failed", amount: 17500, payment_intent: "pi_1", charge: "ch_1", failure_reason: "expired_or_canceled_card", metadata: { reason: "homeowner_switched_contractor" } };

Deno.test("gh-3510: refund.failed for a switch refund creates exactly one alert naming claim, quote, PI and refund", async () => {
  const { sb, alerts } = fakeSb();
  assertEquals(await handleSwitchRefundFailed("refund.failed", failedRefund, sb, "stripe-webhook"), "alerted");
  assertEquals(alerts.length, 1);
  const m = String(alerts[0].message);
  assert(m.includes("OPS: refund FAILED") && m.includes("claim c-1") && m.includes("quote q-1") && m.includes("PI pi_1") && m.includes("refund re_1 "));
  assertEquals(alerts[0].alert_type, "switch_refund_failed");
});

Deno.test("gh-3510: a retry, or the same failure arriving as charge.refund.updated, creates no second alert", async () => {
  const { sb, alerts } = fakeSb();
  await handleSwitchRefundFailed("refund.failed", failedRefund, sb, "stripe-webhook");
  assertEquals(await handleSwitchRefundFailed("refund.failed", failedRefund, sb, "stripe-webhook"), "duplicate");
  assertEquals(await handleSwitchRefundFailed("charge.refund.updated", { ...failedRefund, status: "canceled" }, sb, "stripe-webhook"), "duplicate");
  assertEquals(alerts.length, 1);
});

Deno.test("gh-3510: succeeded, pending and requires_action refunds do nothing", async () => {
  for (const status of ["succeeded", "pending", "requires_action"]) {
    const { sb, writes } = fakeSb();
    assertEquals(await handleSwitchRefundFailed("refund.updated", { ...failedRefund, status }, sb, "stripe-webhook"), "ignored");
    assertEquals(writes.length, 0);
  }
});

Deno.test("gh-3510: a failed refund that is not a switch refund, or an unrelated event type, does nothing", async () => {
  const a = fakeSb();
  assertEquals(await handleSwitchRefundFailed("refund.failed", { ...failedRefund, metadata: {} }, a.sb, "stripe-webhook"), "ignored");
  const b = fakeSb();
  assertEquals(await handleSwitchRefundFailed("charge.refunded", failedRefund, b.sb, "stripe-webhook"), "ignored");
  assertEquals(a.writes.length + b.writes.length, 0);
});

Deno.test("gh-3510: the handler writes only the alert row (no quote update, no money, no email)", async () => {
  const { sb, writes } = fakeSb();
  await handleSwitchRefundFailed("refund.failed", failedRefund, sb, "stripe-webhook");
  assertEquals(writes, ["insert:platform_alerts_log"]);
  const src = stripComments(Deno.readTextFileSync(new URL("./refund-failed.ts", import.meta.url)));
  assert(!/fetch\(|mailgun|api\.stripe\.com/i.test(src));
});

Deno.test("gh-3510: a dedupe lookup error reports 'error' (caller returns 500 so Stripe retries) and writes nothing", async () => {
  const { sb, writes } = fakeSb({ lookupError: true });
  assertEquals(await handleSwitchRefundFailed("refund.failed", failedRefund, sb, "stripe-webhook"), "error");
  assertEquals(writes.length, 0);
});

Deno.test("gh-3510: index.ts dispatches the refund events after the signature check and event ledger", () => {
  const src = stripComments(Deno.readTextFileSync(new URL("./index.ts", import.meta.url)));
  const sig = src.indexOf("Stripe signature verification failed");
  const ledger = src.indexOf('.from("stripe_webhook_events")');
  const dispatch = src.indexOf("handleSwitchRefundFailed(event.type");
  assert(sig > 0 && ledger > sig && dispatch > ledger, "dispatch must come after signature verification and the ledger insert");
});
