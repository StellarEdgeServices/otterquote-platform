/**
 * Contractor Partner Agreement (CPA) version guard — D-211 Phase 2 (contractor-track shell)
 *
 * Single source of truth for the CPA re-attestation MECHANISM that is copy-pasted
 * across the static contractor pages (contractor-dashboard / -opportunities /
 * -bid-form / -auto-bids / -profile). Pure + framework-free so every contractor
 * page reuses it rather than re-implementing it.
 *
 * ⚠️ Mechanism only — NOT legal copy. The verbatim, D-230 / Tier-3 re-attestation
 * MODAL COPY lives with the page that renders the modal (contractor-dashboard's
 * copy.ts) and is gated to Dustin. This file only decides WHETHER re-attestation
 * is required and manages the cross-page anti-loop redirect guard.
 *
 * Ported from contractor-dashboard.html:997 (CURRENT_CPA_VERSION),
 * contractor-dashboard.html:1438 (modal trigger) and
 * contractor-auto-bids.html:644 (non-dashboard redirect guard).
 */

// Bump this string when the Contractor Partner Agreement changes. Any contractor
// whose contractors.cpa_version !== CURRENT_CPA_VERSION — or whose D-230
// needs_cpa_reattestation flag is true — must re-accept before continuing.
export const CURRENT_CPA_VERSION = 'v1-2026-04';

// localStorage key for the anti-loop redirect guard shared across contractor pages.
export const CPA_REDIRECT_GUARD_KEY = 'oq_cpa_redirect_guard';

/** Minimal shape this guard reads off the contractors row. */
export interface CpaGuardContractor {
  cpa_version?: string | null;
  needs_cpa_reattestation?: boolean | null;
  agreement_accepted_at?: string | null;
}

/**
 * True when the contractor must re-accept the CPA: their recorded version is
 * behind CURRENT_CPA_VERSION, OR D-230 flagged them for re-attestation.
 * Mirrors contractor-dashboard.html:1438 and contractor-auto-bids.html:644.
 */
export function needsCpaReattestation(
  contractor: CpaGuardContractor | null | undefined,
): boolean {
  if (!contractor) return false;
  return (
    contractor.cpa_version !== CURRENT_CPA_VERSION ||
    contractor.needs_cpa_reattestation === true
  );
}

/**
 * Dashboard-modal gate: the re-acceptance modal is shown only AFTER the
 * first-time agreement has been accepted (so the first-time and re-accept modals
 * never stack) and only when re-attestation is needed.
 * Mirrors contractor-dashboard.html:1438 (guarded by agreement_accepted_at).
 */
export function shouldShowCpaModal(
  contractor: CpaGuardContractor | null | undefined,
): boolean {
  if (!contractor) return false;
  return !!contractor.agreement_accepted_at && needsCpaReattestation(contractor);
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;
type RemoveStorage = Pick<Storage, 'removeItem'>;

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** True when the cross-page anti-loop redirect guard is currently set. */
export function isCpaRedirectGuardSet(storage: ReadStorage | null = safeLocalStorage()): boolean {
  try {
    return !!storage && storage.getItem(CPA_REDIRECT_GUARD_KEY) != null;
  } catch {
    return false;
  }
}

/** Set the anti-loop redirect guard. */
export function setCpaRedirectGuard(storage: WriteStorage | null = safeLocalStorage()): void {
  try {
    storage?.setItem(CPA_REDIRECT_GUARD_KEY, '1');
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Clear the anti-loop redirect guard (called once CPA is current / re-accepted). */
export function clearCpaRedirectGuard(storage: RemoveStorage | null = safeLocalStorage()): void {
  try {
    storage?.removeItem(CPA_REDIRECT_GUARD_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * Non-dashboard contractor pages call this on load. If the contractor's CPA is
 * stale and we have NOT already bounced them once, set the guard and redirect to
 * the dashboard (which renders the re-acceptance modal). The guard prevents an
 * infinite dashboard<->page redirect loop. If the CPA is current, any stale guard
 * is cleared. Returns true when a redirect was issued.
 * Mirrors contractor-auto-bids.html:644-647 (the copy-pasted pattern).
 */
export function enforceCpaRedirect(
  contractor: CpaGuardContractor | null | undefined,
  redirect: (url: string) => void,
  dashboardUrl: string = '/contractor/dashboard',
  storage: Storage | null = safeLocalStorage(),
): boolean {
  if (!needsCpaReattestation(contractor)) {
    clearCpaRedirectGuard(storage);
    return false;
  }
  if (isCpaRedirectGuardSet(storage)) return false; // already bounced once
  setCpaRedirectGuard(storage);
  redirect(dashboardUrl);
  return true;
}
