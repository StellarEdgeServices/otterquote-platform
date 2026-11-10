// gh-3510 (Refs #3493 ruling 6689708951): a switch refund that was 'pending' at create and FAILS later.
// switch-contractor (gh-3493) treats a refund that is failed/canceled/requires_action AT CREATE as not refunded and logs
// "OPS: refund FAILED". A refund that fails after creation reaches us only as a Stripe event. This module turns that event
// into the same OPS signal: one platform_alerts_log row (the table the other handlers here alert through) plus an
// "OPS: refund FAILED" console line. It moves no money, sends no email, and writes nothing else.
//
// Events (confirm the endpoint is subscribed; see the PR body): refund.failed, refund.updated (API 2024-10-28.acacia and
// later, all refunds) and charge.refund.updated (older API versions). All three can describe the same failure, so the
// alert is deduped on the refund id, not only on the event id (the stripe_webhook_events ledger already dedupes retries).
// Kept out of index.ts because index.ts starts a server at import time.

export const REFUND_EVENT_TYPES = ["refund.failed", "refund.updated", "charge.refund.updated"];
/** Same meaning as switch-contractor's REFUND_NOT_DONE_STATUSES, minus 'requires_action' (that one is a create-time state). */
export const REFUND_FAILED_AFTER_CREATE_STATUSES = ["failed", "canceled"];
export const SWITCH_REFUND_REASON = "homeowner_switched_contractor"; // the metadata[reason] switch-contractor sets on its refund
export const SWITCH_REFUND_ALERT_TYPE = "switch_refund_failed";

export interface StripeRefundObject {
  id: string;
  status?: string | null;
  amount?: number;
  payment_intent?: string | null;
  charge?: string | null;
  failure_reason?: string | null;
  metadata?: Record<string, string> | null;
}

// deno-lint-ignore no-explicit-any
type Sb = any;

export type RefundFailedOutcome = "alerted" | "ignored" | "duplicate" | "error";

export async function handleSwitchRefundFailed(
  eventType: string,
  refund: StripeRefundObject,
  supabase: Sb,
  fnName: string,
): Promise<RefundFailedOutcome> {
  if (!REFUND_EVENT_TYPES.includes(eventType)) return "ignored";
  if (!refund || !REFUND_FAILED_AFTER_CREATE_STATUSES.includes(String(refund.status))) return "ignored"; // succeeded / pending: nothing to do
  if (refund.metadata?.reason !== SWITCH_REFUND_REASON) return "ignored"; // scope: switch refunds only

  // Same refund already alerted (e.g. refund.failed then charge.refund.updated for one failure).
  const { data: seen, error: seenErr } = await supabase
    .from("platform_alerts_log")
    .select("id")
    .eq("alert_type", SWITCH_REFUND_ALERT_TYPE)
    .like("message", `%refund ${refund.id} %`)
    .limit(1);
  if (seenErr) {
    console.error(`[${fnName}] ${eventType}: alert dedupe lookup failed for refund ${refund.id}:`, seenErr);
    return "error"; // caller must not swallow: a lookup failure is not a reason to stay silent or to double-alert
  }
  if (seen && seen.length > 0) return "duplicate";

  let claimId = "unknown";
  let quoteId = "unknown";
  const pi = refund.payment_intent ?? null;
  if (pi) {
    const { data: quote } = await supabase.from("quotes").select("id, claim_id").eq("payment_intent_id", pi).maybeSingle();
    if (quote) {
      claimId = quote.claim_id;
      quoteId = quote.id;
    }
  }
  const why = refund.failure_reason ? ` (${refund.failure_reason})` : "";
  const line = `OPS: refund FAILED after creation -- claim ${claimId}, quote ${quoteId}, PI ${pi ?? "unknown"}, refund ${refund.id} status '${refund.status}'${why}. The switch completed and the contractor was told the refund was issued; the platform-fee refund is owed and must be checked by hand.`;
  console.error(`[${fnName}] ${line}`);

  const { error: alertErr } = await supabase.from("platform_alerts_log").insert({
    alert_type: SWITCH_REFUND_ALERT_TYPE,
    function_name: fnName,
    message: `${line} Detected via ${eventType} (gh-3510).`,
    sent_at: new Date().toISOString(),
  });
  if (alertErr) {
    console.error(`[${fnName}] platform_alerts_log insert failed for refund ${refund.id}:`, alertErr);
    return "error";
  }
  return "alerted";
}
