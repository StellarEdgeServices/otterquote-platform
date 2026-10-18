// [gh-2559 / D-390] Homeowner-typed text that reaches the SELECTED contractor before the Platform Fee is collected has its phone-shaped and
// e-mail-shaped text removed. The patterns live in ONE place, the Postgres function public.d390_redact_contact (the bidder rule b/c patterns of
// ledger 20261008231303), so the browser views, the Scope of Work and the notification e-mail redact identically. This helper only decides WHEN
// (fee not collected) and fails CLOSED: if the function cannot be reached, the text is withheld, never sent as typed.
//
// feeCollected must be `claims.platform_fee_charged === true` (the column is nullable: null and false both redact).

export const WITHHELD_TEXT = "[Notes withheld until the Platform Fee is collected]";

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

export async function homeownerTextForContractor(
  supabase: RpcClient,
  text: string | null | undefined,
  feeCollected: boolean,
): Promise<string | null> {
  if (text === null || text === undefined || text === "") return text ?? null;
  if (feeCollected === true) return text;
  try {
    const { data, error } = await supabase.rpc("d390_redact_contact", { p_text: String(text).slice(0, 2000) });
    if (error || typeof data !== "string") {
      console.error("gh-2559 D-390: d390_redact_contact failed; text withheld", error?.message ?? "no data");
      return WITHHELD_TEXT;
    }
    return data;
  } catch (e) {
    console.error("gh-2559 D-390: d390_redact_contact threw; text withheld", e instanceof Error ? e.message : String(e));
    return WITHHELD_TEXT;
  }
}
