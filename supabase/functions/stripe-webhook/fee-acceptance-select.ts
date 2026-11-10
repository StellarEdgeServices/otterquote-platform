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
  // gh-3490: one bid can hold several acceptance rows with different fees (a changed or renewed bid writes its own row).
  // A price that goes A -> B -> A writes no new row for the return to A, so the newest row (B) is not the one that matches.
  // Take the NEWEST row whose fee equals the bid's current fee (same tolerance as before); only if none matches is it fee_differs_from_bid.
  const bidFee = Number(bid.fee_amount);
  const row = own.find((r) => {
    const rowFee = Number(r.fee_amount);
    return Number.isFinite(rowFee) && Number.isFinite(bidFee) && Math.abs(rowFee - bidFee) < 0.005;
  });
  if (!row) return { row: null, reason: "fee_differs_from_bid" };
  return { row, reason: "ok" };
}

/** What the dispute task and the service documentation say when no acceptance may be used. Never "no record" when a record exists. */
export function describeMissingFeeAcceptance(reason: AcceptancePickReason | null | undefined): string {
  switch (reason) {
    case "fee_differs_from_bid":
      return "A fee_acceptances record exists for the selected bid but its fee differs from the bid's current fee (the bid was revised or its price moved after acceptance); it is NOT used as evidence. Manual evidence gathering required: read the row and the bid history.";
    case "no_row_for_selected_bid":
      return "No fee_acceptances record found for the selected bid (a diverted acceptance, if any, is in fee_acceptance_quarantine) — manual evidence gathering required.";
    case "no_selected_bid":
      return "The selected bid could not be identified, so no fee_acceptances record was used — manual evidence gathering required.";
    default:
      return "No fee_acceptances record found — manual evidence gathering required.";
  }
}

/**
 * The line staged at Stripe. Never names an internal table or reason (a person finishes that draft and Stripe keeps it), and never both says "not found"
 * and "a record exists". The internal reason goes to the ClickUp task (describeMissingFeeAcceptance). Starts with the literal the gates look for.
 */
export function describeMissingFeeAcceptanceForStripe(reason: AcceptancePickReason | null | undefined): string {
  return reason === "fee_differs_from_bid"
    ? "Not found in database as a record usable for this charge — manual lookup required."
    : "Not found in database — manual lookup required.";
}

/** The slice of the supabase-js query builder this needs; a test passes a fake. */
// deno-lint-ignore no-explicit-any
export type QueryBuilder = any;
export interface DbLike {
  from(table: string): QueryBuilder;
}

interface PaidQuote {
  id: string;
  claim_id: string;
  fee_amount: number | string | null;
}

const FEE_ACCEPTANCE_COLUMNS =
  "id, contractor_id, claim_id, bid_id, fee_pct, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent, invoice_url";

/**
 * Finds the acceptance a dispute may use: the SELECTED bid's, with the bid's own fee (see the file header).
 * The bid is the quote the payment intent resolved (when it belongs to this claim), else the claim's selected quote
 * for the selected contractor. The acceptance query filters on bid_id itself, so a contractor who piles up other bids
 * cannot push the selected bid's row out of a limited result.
 */
export async function loadFeeAcceptanceForDispute<T extends AcceptanceCandidate>(
  db: DbLike,
  claim: { id: string },
  contractorId: string,
  paidQuote: PaidQuote | null,
): Promise<{ row: T | null; reason: AcceptancePickReason }> {
  let selectedBid: SelectedBid | null = paidQuote && paidQuote.claim_id === claim.id
    ? { id: paidQuote.id, fee_amount: paidQuote.fee_amount }
    : null;
  if (!selectedBid) {
    const { data: selRows } = await db
      .from("quotes")
      .select("id, fee_amount")
      .eq("claim_id", claim.id)
      .eq("contractor_id", contractorId)
      .eq("status", "selected")
      .order("created_at", { ascending: false })
      .limit(1);
    const sel = (selRows ?? []) as { id: string; fee_amount: number | null }[];
    if (sel.length > 0) selectedBid = { id: sel[0].id, fee_amount: sel[0].fee_amount };
  }
  if (!selectedBid) return { row: null, reason: "no_selected_bid" };
  const { data: feeRows } = await db
    .from("fee_acceptances")
    .select(FEE_ACCEPTANCE_COLUMNS)
    .eq("claim_id", claim.id)
    .eq("contractor_id", contractorId)
    .eq("bid_id", selectedBid.id)
    .is("rescinded_at", null)
    .order("created_at", { ascending: false })
    // gh-3490: was 5, which could cut off the older row that matches the bid's current fee (A -> B -> A). The query already
    // filters to one bid, so rows are few; 50 is a generous bound that keeps the read small without hiding a match.
    .limit(50);
  return pickFeeAcceptanceForBid(feeRows as T[] | null, selectedBid);
}
