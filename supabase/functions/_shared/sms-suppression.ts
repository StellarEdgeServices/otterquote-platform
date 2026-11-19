/**
 * gh-3768 (child of gate #3726): send-side defence in depth for the SMS suppression list.
 *
 * Every contractor sender already filters its recipients through contractor_textable_numbers(), which excludes a number
 * with an open row on public.sms_suppression_list. send-sms itself did not look, so a future caller that passed a raw
 * number would bypass an opt-out. send-sms now calls checkSmsSuppression() after the pause check and before the rate
 * limit and the Twilio request, and refuses when the number has an open row (released_at IS NULL).
 *
 * Fail-closed: a number we cannot key, a lookup error, a thrown lookup, or a table that is missing all REFUSE. (Unlike the
 * pause table, sms_suppression_list exists in production, so "missing" is a real fault, not "nothing flagged".)
 *
 * Distinct, non-silent refusals (error codes in the response body):
 *   number_suppressed            403  an open suppression row exists for the number
 *   suppression_lookup_failed    503  we could not tell (lookup error, or number could not be normalised)
 * The log line carries the LAST 4 DIGITS ONLY, never the full number.
 *
 * No bypass: the owner alert (send-contractor-nudge -> send-sms) goes through the same check; the owner's number is not on
 * the list, so it is sent. Nothing here changes any customer-facing wording.
 */
import { toE164 } from "./sms-pause.ts";

/** The slice of the supabase-js client this module needs (structural, so tests can fake it). */
// deno-lint-ignore no-explicit-any
export interface SuppressionClient { from(table: string): any }

export type SuppressionVerdict =
  | { suppressed: false }
  | { suppressed: true; reason: "open_suppression" | "lookup_failed" | "unparseable_number" };

/** Last four digits of whatever was passed, for logs. Never returns more than four characters. */
export function last4(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "????";
}

export async function isSmsSuppressed(sb: SuppressionClient, rawTo: string | null | undefined): Promise<SuppressionVerdict> {
  // Same normaliser the pause check and twilio-sms-optout use; the table stores E.164 (CHECK ^\+[1-9][0-9]{7,14}$).
  const phone = toE164(rawTo);
  if (!phone) return { suppressed: true, reason: "unparseable_number" };
  try {
    const { data, error } = await sb.from("sms_suppression_list").select("id").eq("phone_e164", phone).is("released_at", null).limit(1) as
      { data: unknown[] | null; error: { code?: string } | null };
    if (error) return { suppressed: true, reason: "lookup_failed" };
    return data && data.length > 0 ? { suppressed: true, reason: "open_suppression" } : { suppressed: false };
  } catch {
    return { suppressed: true, reason: "lookup_failed" };
  }
}

/**
 * The refusal Response for a verdict, or null when the send may proceed. Logs one line with the last 4 digits only.
 * The caller must return the Response without touching Twilio.
 */
export async function smsSuppressionRefusal(
  sb: SuppressionClient,
  rawTo: string | null | undefined,
  corsHeaders: Record<string, string>,
  fn: string, // gh-3773: REQUIRED (no default label), so this shared module never carries a "send-sms" string of its own
  log: (line: string) => void = console.warn,
): Promise<Response | null> {
  const v = await isSmsSuppressed(sb, rawTo);
  if (!v.suppressed) return null;
  const headers = { ...corsHeaders, "Content-Type": "application/json" };
  if (v.reason === "open_suppression") {
    log(`[${fn}] SMS refused: number_suppressed (open sms_suppression_list row), to_last4=${last4(rawTo)}. No Twilio call attempted.`);
    return new Response(JSON.stringify({ error: "number_suppressed", reason: v.reason }), { status: 403, headers });
  }
  log(`[${fn}] SMS refused: suppression_lookup_failed (${v.reason}), to_last4=${last4(rawTo)}. No Twilio call attempted.`);
  return new Response(JSON.stringify({ error: "suppression_lookup_failed", reason: v.reason }), { status: 503, headers });
}
