// [gh-2559 / D-390] Homeowner-typed text that reaches the SELECTED contractor before the Platform Fee is collected has its phone-shaped and
// e-mail-shaped text removed. The patterns live in ONE place, the Postgres function public.d390_redact_contact (the bidder rule b/c patterns of
// ledger 20261008231303), so the browser views, the Scope of Work and the notification e-mail redact identically. This helper only decides WHEN
// (fee not collected) and fails CLOSED: if the function cannot be reached, the typed text is never passed on. What happens instead depends on the
// surface, and neither prints any wording of our own (LEGAL-READ 6256212786 L1):
//   - Scope of Work (a signed document): redactContactOrRefuse() throws RedactionUnavailableError; the caller refuses to build the envelope.
//   - e-mail preview: homeownerTextForContractor() returns REMOVED_TOKEN, the same token the success path produces.
//
// feeCollected must be `claims.platform_fee_charged === true` (the column is nullable: null and false both redact).

export const REMOVED_TOKEN = "[removed]";

export class RedactionUnavailableError extends Error {
  readonly code = "d390_redaction_unavailable";
  constructor(reason: string) {
    super(`d390_redact_contact unavailable: ${reason}`);
    this.name = "RedactionUnavailableError";
  }
}

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

// Core: returns the redacted text, or throws RedactionUnavailableError when the rpc errors, returns no string, or throws.
export async function redactContactOrRefuse(
  supabase: RpcClient,
  text: string | null | undefined,
  feeCollected: boolean,
): Promise<string | null> {
  if (text === null || text === undefined || text === "") return text ?? null;
  if (feeCollected === true) return text;
  let res: { data: unknown; error: { message?: string } | null };
  try {
    res = await supabase.rpc("d390_redact_contact", { p_text: String(text).slice(0, 2000) });
  } catch (e) {
    throw new RedactionUnavailableError(e instanceof Error ? e.message : String(e));
  }
  if (res.error || typeof res.data !== "string") {
    throw new RedactionUnavailableError(res.error?.message ?? "no data");
  }
  return res.data;
}

// E-mail preview variant: on failure, log the reason and use the success-path token. No fee reference, no other wording.
export async function homeownerTextForContractor(
  supabase: RpcClient,
  text: string | null | undefined,
  feeCollected: boolean,
): Promise<string | null> {
  try {
    return await redactContactOrRefuse(supabase, text, feeCollected);
  } catch (e) {
    console.error("gh-2559 D-390: redaction failed; preview text replaced with the removed token", e instanceof Error ? e.message : String(e));
    return REMOVED_TOKEN;
  }
}
