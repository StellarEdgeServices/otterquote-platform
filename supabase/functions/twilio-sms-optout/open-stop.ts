/**
 * #3771: the open-row check behind Deps.hasOpenStop. True when an open suppression row exists for the number that STAFF
 * cannot release (any channel except email / support_call: sms_keyword, sms_freeform, carrier_disconnect). Null on a read
 * error. Kept in its own file, taking the client as a parameter, so a test can drive the real filter chain.
 */
// deno-lint-ignore no-explicit-any
export async function hasOpenStopRow(sb: any, phone: string): Promise<boolean | null> {
  const { data, error } = await sb.from("sms_suppression_list").select("id")
    .eq("phone_e164", phone).is("released_at", null).not("channel", "in", "(email,support_call)").limit(1);
  if (error) return null;
  return (data?.length ?? 0) > 0;
}
