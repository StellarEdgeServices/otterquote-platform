/**
 * gh-2442 (REVIEW 6275827939 B4): reminders, the final warning and the homeowner notice must not run for a quote whose
 * fee is already paid or has money in motion (ACH 'processing' / recorded 'pending'). Before this, PASS 1 and PASS 2 of
 * the CRON mode never looked at quotes.payment_status, so a bank payment in flight could still produce a
 * "your contractor has not paid" notice. Pure filter + one read; erasable TypeScript only (tested under node).
 */
import { PAYMENT_HOLD_STATUSES } from "./retry-pass.ts";

export async function heldQuoteIds(supabase: any, quoteIds: Array<string | null | undefined>): Promise<Set<string>> {
  const ids = [...new Set(quoteIds.filter((q): q is string => !!q))];
  const held = new Set<string>();
  if (ids.length === 0) return held;
  const { data, error } = await supabase.from("quotes").select("id, payment_status").in("id", ids);
  if (error) {
    console.error("[process-dunning] payment-hold lookup failed; reminder passes run as before:", error);
    return held;
  }
  for (const q of (data ?? []) as Array<{ id: string; payment_status: string | null }>) {
    if (q.payment_status && PAYMENT_HOLD_STATUSES.includes(q.payment_status)) held.add(q.id);
  }
  return held;
}

export function dropHeld<T extends { quote_id?: string | null; id?: string }>(rows: T[], held: Set<string>): T[] {
  return rows.filter((r) => {
    if (r.quote_id && held.has(r.quote_id)) {
      console.log(`[process-dunning] holding failure ${r.id}: quote ${r.quote_id} payment is paid or in flight.`);
      return false;
    }
    return true;
  });
}
