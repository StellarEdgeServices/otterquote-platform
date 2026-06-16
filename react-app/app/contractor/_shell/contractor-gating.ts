/**
 * Contractor pending-approval gate — D-211 Phase 2 (contractor-track shell)
 *
 * Pure helper for the "account under review" gate that is copy-pasted across the
 * static contractor pages. A contractor is "active" once an admin approves them;
 * until then status !== 'active', most actions (e.g. bidding) are gated, and the
 * pending banner is shown. Ported from contractor-dashboard.html:1421-1424.
 */

export interface ContractorStatusRecord {
  status?: string | null;
}

/**
 * True when the contractor is NOT yet approved/active (status present and
 * !== 'active'). A missing/empty status is treated as NOT pending, matching the
 * static guard, which only shows the banner when a status exists and is not
 * 'active' (contractor-dashboard.html:1422-1423).
 */
export function isPendingApproval(
  contractor: ContractorStatusRecord | null | undefined,
): boolean {
  if (!contractor) return false;
  const status = contractor.status;
  return !!status && status !== 'active';
}
