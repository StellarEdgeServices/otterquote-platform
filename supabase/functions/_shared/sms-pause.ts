/**
 * D-391 / #2875: the send-side half of the free-text opt-out flagger.
 *
 * twilio-sms-optout queues an inbound text that contains an opt-out keyword as a whole word on public.sms_optout_review
 * (status 'pending'). A pending row PAUSES every send to that number (Marty's ruling, #2875 comment 6365843245).
 * Every code path that can put a text on the wire (send-sms, process-dunning) calls isSmsPaused() immediately before the
 * Twilio request and refuses when it answers paused.
 *
 * Fail-closed, with one deliberate exception: if the review table does not exist yet (migration not applied), nothing
 * can have been flagged, so the answer is "not paused". Any other lookup error pauses (we do not text when we cannot tell).
 */

/** Best-effort E.164 for a US-centric caller string: "+13175551234", "317-555-1234", "(317) 555 1234", "1 317 555 1234". */
export function toE164(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The slice of the supabase-js client this module needs (structural, so tests can fake it). */
// deno-lint-ignore no-explicit-any
export interface PauseClient { from(table: string): any }

export type PauseVerdict = { paused: false } | { paused: true; reason: "pending_review" | "lookup_failed" };

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

export async function isSmsPaused(sb: PauseClient, rawTo: string | null | undefined): Promise<PauseVerdict> {
  const phone = toE164(rawTo);
  if (!phone) return { paused: false }; // not a number we can key on; it cannot match a flagged E.164 row
  try {
    const { data, error } = await sb.from("sms_optout_review").select("id").eq("phone_e164", phone).eq("status", "pending").limit(1) as
      { data: unknown[] | null; error: { code?: string } | null };
    if (error) {
      if (error.code && MISSING_TABLE_CODES.has(error.code)) return { paused: false };
      return { paused: true, reason: "lookup_failed" };
    }
    return data && data.length > 0 ? { paused: true, reason: "pending_review" } : { paused: false };
  } catch {
    return { paused: true, reason: "lookup_failed" };
  }
}
