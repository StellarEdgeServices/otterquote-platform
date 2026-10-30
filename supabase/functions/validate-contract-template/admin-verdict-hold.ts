// gh-3224: keep an admin's verdict on a contractor template intact.
//
// Two rules, shared by the fresh path (index.ts) and the re-validation pass (revalidate.ts):
//
//  1. HOLD. A template whose last admin verdict was `rejected` may never reach auto_validated or
//     manual_validated on a scan alone. When the scan would write one of those, the row lands on
//     `submitted_for_admin_review` instead, and an admin decides. "Last admin verdict" is read from the
//     append-only contractor_template_verdicts log (draft migration gh3224_template_verdict_log.sql)
//     through template_admin_verdict_blocks_auto_validation(uuid), which a contractor cannot write, clear or
//     delete: the upload reset (contractor_templates_freeze_verdict) touches the template row only.
//     A failed lookup FAILS CLOSED: the caller writes nothing.
//
//  2. SKIP. revalidate_all leaves `rejected` and `admin_validated` rows alone unless an admin passes
//     `force_admin_verdicts: true` (admin JWT only; the service-role key cannot).

// deno-lint-ignore-file no-explicit-any

export const HOLD_STATUS = "submitted_for_admin_review";
export const ADMIN_VERDICT_STATUSES = ["rejected", "admin_validated"] as const;

export const HELD_FOR_ADMIN_NOTICE =
  "This template was rejected in admin review earlier, so it has been sent back to an admin for a decision instead of being validated.";

/** Statuses a scan may write that count as a validated template. */
export function isValidatedStatus(s: string): boolean {
  return s === "auto_validated" || s === "manual_validated";
}

/** revalidate_all: should this row be left alone? */
export function skipForAdminVerdict(status: string | null | undefined, forceAdminVerdicts: boolean): boolean {
  if (forceAdminVerdicts) return false;
  return (ADMIN_VERDICT_STATUSES as readonly string[]).includes(String(status ?? ""));
}

export type HoldResult =
  | { ok: true; hold: boolean }
  | { ok: false; error: string };

/**
 * Ask the database whether the last admin verdict for this template was a rejection.
 * Any error, or a non-boolean answer, is `ok:false` so the caller can refuse to write.
 */
export async function lookupRejectionHold(supabase: any, templateId: string): Promise<HoldResult> {
  try {
    const { data, error } = await supabase.rpc("template_admin_verdict_blocks_auto_validation", { p_template_id: templateId });
    if (error) return { ok: false, error: String(error.message ?? error) };
    if (typeof data !== "boolean") return { ok: false, error: "unexpected lookup result" };
    return { ok: true, hold: data };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Apply the HOLD rule to a status the scan wants to write. Statuses that are not validated pass through
 * without a lookup (nothing to hold, and no database round trip on a failing scan).
 */
export async function applyRejectionHold(
  supabase: any,
  templateId: string,
  wantedStatus: string,
): Promise<{ ok: true; status: string; held: boolean } | { ok: false; error: string }> {
  if (!isValidatedStatus(wantedStatus)) return { ok: true, status: wantedStatus, held: false };
  const r = await lookupRejectionHold(supabase, templateId);
  if (!r.ok) return r;
  return r.hold ? { ok: true, status: HOLD_STATUS, held: true } : { ok: true, status: wantedStatus, held: false };
}
