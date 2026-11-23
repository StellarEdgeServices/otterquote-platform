// gh-3848: the auto-renew swap, in the order the manual-bid unique index (quotes_manual_bid_uidx) needs.
//
// The index allows ONE live (active or expired) non-auto bid per claim and contractor. The old order inserted the renewal clone
// while the original was still active, so the two collided. This supersedes the ORIGINAL first, then inserts the clone, and puts the
// original back if the clone cannot be inserted. Pure of Deno/env so a test can drive it with a recording fake client.
//
// States against the index predicate (is_auto_bid IS NOT TRUE AND bid_status IN ('active','expired')):
//   original active (in index) -> superseded (out) -> clone active (in) ; on clone failure original superseded -> active again (in).
// There is never a moment with two rows in the index. For a short moment (two statements) there is no live bid for the claim.
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface SwapQuote { id: string; claim_id: string; contractor_id: string; total_price: unknown; auto_renew: unknown; trade_type: unknown }
export interface SwapResult {
  /** "renewed" = clone inserted, original superseded. "skipped" = the original could not be superseded; nothing changed, do not expire it. "insert_failed" = clone failed, original restored. */
  outcome: "renewed" | "skipped" | "insert_failed";
  newQuoteId?: string;
  errors: string[];
}

export async function swapInRenewalClone(supabase: Sb, quote: SwapQuote, newExpiresAt: string, now: string): Promise<SwapResult> {
  const errors: string[] = [];

  // 1. Supersede the original, conditioned on it still being active (a row changed since the read matches zero rows).
  const { error: supersedeErr, data: supersedeRows } = await supabase
    .from("quotes")
    .update({ bid_status: "superseded", expired_at: now })
    .eq("id", quote.id)
    .eq("bid_status", "active")
    .select("id");
  if (supersedeErr || !checkRowsWritten(supersedeRows).wroteRows) {
    console.error(zeroRowWriteMessage("process-bid-expirations", `quotes.bid_status=superseded for quote ${quote.id}`), supersedeErr?.message ?? "");
    errors.push(`Supersede update failed for ${quote.id}: ${supersedeErr?.message ?? "zero rows matched (gh-2105)"}`);
    return { outcome: "skipped", errors };
  }

  // 2. Insert the renewal clone.
  const { data: newQuote, error: insertError } = await supabase
    .from("quotes")
    .insert({
      claim_id: quote.claim_id,
      contractor_id: quote.contractor_id,
      total_price: quote.total_price,
      auto_renew: quote.auto_renew,
      renewed_from_quote_id: quote.id,
      expires_at: newExpiresAt,
      bid_status: "active",
      trade_type: quote.trade_type,
      // value_adds and other JSON fields are intentionally not cloned here (renewal stays lightweight).
    })
    .select("id")
    .single();

  if (!insertError && newQuote?.id) return { outcome: "renewed", newQuoteId: newQuote.id, errors };

  console.error(`[process-bid-expirations] Auto-renew insert failed for quote ${quote.id}:`, insertError?.message);
  errors.push(`Auto-renew insert failed for ${quote.id}: ${insertError?.message}`);

  // 3. Compensate: the original goes back to active so the caller's expiry path handles it exactly as before.
  const { error: restoreErr, data: restoreRows } = await supabase
    .from("quotes")
    .update({ bid_status: "active", expired_at: null })
    .eq("id", quote.id)
    .eq("bid_status", "superseded")
    .select("id");
  if (restoreErr || !checkRowsWritten(restoreRows).wroteRows) {
    console.error(zeroRowWriteMessage("process-bid-expirations", `quotes.bid_status=active (restore after failed renewal) for quote ${quote.id}`), restoreErr?.message ?? "");
    errors.push(`Restore after failed renewal failed for ${quote.id}: ${restoreErr?.message ?? "zero rows matched (gh-2105)"}`);
  }
  return { outcome: "insert_failed", errors };
}
