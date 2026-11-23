// gh-3861 (P23 piece E) -- pure decision for the hand-off to contractors after a measurement
// report is fulfilled. No I/O, no Deno, no Supabase: index.ts feeds it two rows and acts on the
// answer. Mirrors what dashboard.html submitForBids() writes when the homeowner clicks Submit
// (status 'active', ready_for_bids true, {trade}_bid_released_at for roofing and gutters) and its
// gh-3783 (D-375) windows refusal, so the server path opens a claim exactly as the browser path does.

export const FLAG_ENV = "MEASUREMENT_CHARGE_ENABLED";
export const HANDOFF_EVENT = "measurement_handoff_to_contractors";

/** Same list as dashboard.html submitForBids(): siding waits for the D-164 design webhook, windows for D-375. */
export const RELEASABLE_TRADES = ["roofing", "gutters"] as const;

/** Statuses a claim may be in when the hand-off opens it. Anything else (waitlisted, bidding, contract_signed, ...) is left alone. */
export const RELEASABLE_STATUSES = ["draft", "documents_needed", "submitted", "active"] as const;

export interface HandOffOrder {
  id: string;
  claim_id: string | null;
  status: string | null;
  requested_by_role: string | null;
}

export interface HandOffClaim {
  id: string;
  status: string | null;
  ready_for_bids: boolean | null;
  trades: string[] | null;
  is_test?: boolean | null;
  [k: string]: unknown;
}

export type HandOffPlan =
  | { action: "refuse"; status: 404 | 409 | 422; reason: string }
  | { action: "already_open"; reason: "already_released" }
  | { action: "release"; patch: Record<string, unknown>; releasedTrades: string[] };

/** Flag: exactly the string "true" is ON. Unset, "false", "1", "TRUE" are all OFF (fails closed). */
export function flagIsOn(value: string | undefined | null): boolean {
  return value === "true";
}

export function planHandOff(
  order: HandOffOrder | null,
  claim: HandOffClaim | null,
  nowIso: string,
): HandOffPlan {
  if (!order) return { action: "refuse", status: 404, reason: "order_not_found" };
  // The report must actually be fulfilled: same test send-measurement-ready applies before it emails.
  if (order.status !== "completed") return { action: "refuse", status: 409, reason: "report_not_fulfilled" };
  // Only the homeowner-paid report hands the job out. A contractor-requested upgrade (#1411) or an order whose
  // buyer role was never settled (#3447) must not open a homeowner's claim to bidding.
  const role = order.requested_by_role || "homeowner";
  if (role !== "homeowner") return { action: "refuse", status: 409, reason: "not_homeowner_order" };
  if (!order.claim_id || !claim) return { action: "refuse", status: 404, reason: "claim_not_found" };

  const trades = (Array.isArray(claim.trades) && claim.trades.length ? claim.trades : ["roofing"]).map((t) => String(t).toLowerCase());
  // gh-3783 (D-375): a claim that includes windows is refused, before anything is written.
  if (trades.includes("windows")) return { action: "refuse", status: 422, reason: "windows_not_releasable" };

  // Already open (the homeowner clicked Submit, or an earlier hand-off ran): contractors were already told once.
  if (claim.ready_for_bids === true) return { action: "already_open", reason: "already_released" };

  if (!(RELEASABLE_STATUSES as readonly string[]).includes(String(claim.status ?? ""))) {
    return { action: "refuse", status: 409, reason: "claim_status_not_releasable" };
  }

  const patch: Record<string, unknown> = { status: "active", ready_for_bids: true };
  const releasedTrades: string[] = [];
  for (const t of trades) {
    if ((RELEASABLE_TRADES as readonly string[]).includes(t) && !claim[`${t}_bid_released_at`]) {
      patch[`${t}_bid_released_at`] = nowIso;
      releasedTrades.push(t);
    }
  }
  return { action: "release", patch, releasedTrades };
}
