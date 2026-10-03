/**
 * gh-1570: "is this claim's checklist complete", derived from claim columns.
 *
 * Mirrors dashboard.html's isChecklistComplete(): measurements are a hard gate
 * only for cash; the estimate is a hard gate for everything except cash;
 * material selection always. get-homeowner-list/rows.ts carries an inline copy
 * (the EF deploy path does not resolve cross-directory imports); the parity
 * test in checklist-columns.test.ts keeps the two from disagreeing about which
 * draft claims are complete.
 */

export interface ChecklistColumns {
  status?: string | null;
  funding_type?: string | null;
  has_estimate?: boolean | null;
  has_measurements?: boolean | null;
  has_material_selection?: boolean | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export function isChecklistCompleteByColumns(claim: ChecklistColumns): boolean {
  const cash = claim.funding_type === "cash";
  const measurementsOk = !cash || !!claim.has_measurements;
  const estimateOk = cash || !!claim.has_estimate;
  return estimateOk && !!claim.has_material_selection && measurementsOk;
}

/**
 * gh-1570 (CEO ruling 5965042243, "derive-from-columns, no backfill"): the
 * `checklist_complete` event exists only for claims that loaded the dashboard
 * after PR #2081, so a draft that predates it has none. For a `draft` claim
 * with no event, completion is derived at read time from the claim's own
 * columns, clocked from its last update. Other statuses still require the
 * event. Nothing is written.
 */
export function resolveChecklistCompletedAt(
  claim: ChecklistColumns,
  eventCompletedAtIso: string | undefined | null,
): string | undefined {
  if (eventCompletedAtIso != null) return eventCompletedAtIso;
  if (claim.status !== "draft") return undefined;
  if (!isChecklistCompleteByColumns(claim)) return undefined;
  return claim.updated_at ?? claim.created_at ?? undefined;
}
