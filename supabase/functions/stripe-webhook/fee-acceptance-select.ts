/**
 * gh-3409 (REVIEW 6668449870 B1) - which fee_acceptances row a dispute may use as evidence.
 *
 * Before: stripe-webhook took the newest row for (claim, contractor). A contractor can submit a second bid, or move a
 * bid's price down and back, and each acceptance row is true at its own instant, so the newest row could name the wrong
 * bid or a superseded price (a $0.05 fee on a $750.00 bid). The table's own guard (migration gh3409) cannot decide that.
 *
 * Now: the row must belong to the bid being charged (the SELECTED bid), and its fee must equal that bid's current fee.
 * Anything else is NOT evidence: the caller reports "no record, manual evidence gathering" so a person reads it.
 * Pure (no network, no database) so a test can pin it without importing index.ts, which starts a server at import time.
 */
export interface SelectedBid {
  id: string;
  fee_amount: number | string | null;
}

export interface AcceptanceCandidate {
  bid_id: string;
  fee_amount: number | string;
}

export type AcceptancePickReason =
  | "ok"
  | "no_selected_bid"
  | "no_row_for_selected_bid"
  | "fee_differs_from_bid";

/** `rows` are newest first (the query orders by created_at desc). Fee amounts are DOLLARS (numeric(10,2)). */
export function pickFeeAcceptanceForBid<T extends AcceptanceCandidate>(
  rows: readonly T[] | null | undefined,
  bid: SelectedBid | null,
): { row: T | null; reason: AcceptancePickReason } {
  if (!bid) return { row: null, reason: "no_selected_bid" };
  const own = (rows ?? []).filter((r) => r.bid_id === bid.id);
  if (own.length === 0) return { row: null, reason: "no_row_for_selected_bid" };
  const row = own[0];
  const rowFee = Number(row.fee_amount);
  const bidFee = Number(bid.fee_amount);
  if (!Number.isFinite(rowFee) || !Number.isFinite(bidFee) || Math.abs(rowFee - bidFee) >= 0.005) {
    return { row: null, reason: "fee_differs_from_bid" };
  }
  return { row, reason: "ok" };
}
