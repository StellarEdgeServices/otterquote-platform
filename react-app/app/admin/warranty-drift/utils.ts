/**
 * Admin Warranty Manifest Drift — pure logic (D-211 Phase 10).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Port of admin-warranty-drift.html behavior 1:1.
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering
 * in page.tsx is inherently escaped. No HTML strings built here.
 */

// ── Data model ───────────────────────────────────────────────────────────────

export interface DriftCurrentValue {
  tiers?: { tier?: string; display_string?: string }[];
  display_string?: string;
  program_name?: string;
  [k: string]: unknown;
}

export interface DriftProposedValue {
  display_string?: string;
  program_name?: string;
  [k: string]: unknown;
}

export interface DriftRow {
  id: string;
  refresh_run_id?: string;
  detected_at?: string | null;
  manufacturer: string;
  tier: string;
  warranty_option_id?: string | null;
  current_value?: DriftCurrentValue | null;
  proposed_value?: DriftProposedValue | null;
  change_type: string;
  source_url?: string | null;
  status: string;
  rejection_reason?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  applied_at?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

export interface CronMetadata {
  run_id?: string;
  items_detected?: number;
  error?: string;
  [k: string]: unknown;
}

export interface CronHealthRow {
  ran_at: string;
  status: string;
  metadata?: CronMetadata | null;
}

// ── Filter tabs ──────────────────────────────────────────────────────────────

export type DriftFilter =
  | 'pending_review'
  | 'applied'
  | 'rejected'
  | 'skipped'
  | 'all';

export const DRIFT_FILTERS: { key: DriftFilter; label: string }[] = [
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'applied', label: 'Applied' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'all', label: 'All' },
];

// ── Badge helpers ────────────────────────────────────────────────────────────

/**
 * CSS modifier class for the change_type badge.
 * e.g. 'no_source' → 'badge-no-source', 'modified' → 'badge-modified'.
 * Mirrors the badgeClass logic in buildDriftRow() in admin-warranty-drift.html.
 */
export function changeTypeBadgeClass(ct: string): string {
  return 'badge-' + ct.replace('_', '-');
}

/**
 * Human-readable label for change_type.
 * Mirrors changeLabels in buildDriftRow() in admin-warranty-drift.html.
 */
export function changeTypeLabel(ct: string): string {
  const labels: Record<string, string> = {
    no_source: 'Manual Review',
    modified: 'Modified',
    deprecated: 'Deprecated',
    added: 'Added',
  };
  return labels[ct] ?? ct;
}

/**
 * CSS modifier class for the status badge.
 * pending_review → 'badge-pending'; others → 'badge-' + status.replace('_review','').replace('_','-').
 * Mirrors statusBadgeClass logic in buildDriftRow() in admin-warranty-drift.html.
 */
export function statusBadgeClass(status: string): string {
  if (status === 'pending_review') return 'badge-pending';
  return 'badge-' + status.replace('_review', '').replace('_', '-');
}

/**
 * Human-readable label for status. Replaces the first underscore with a space.
 * e.g. 'pending_review' → 'pending review'.
 * Mirrors row.status.replace('_', ' ') in buildDriftRow().
 */
export function statusLabel(status: string): string {
  return status.replace('_', ' ');
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Format an ISO date string to "MMM D, YYYY". Returns '—' for null/undefined/empty.
 * Mirrors formatDate() in admin-warranty-drift.html.
 */
export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Last-run label from ran_at. 'Never' if null/undefined.
 * Mirrors the lastEl.textContent assignment in loadSummary().
 */
export function lastRunLabel(ran_at?: string | null): string {
  return ran_at ? formatDate(ran_at) : 'Never';
}

// ── Run history helpers ──────────────────────────────────────────────────────

/**
 * Status dot color for a cron run row.
 * success → green; skipped_dedup → slate; anything else → red.
 * Mirrors statusColor in loadRunHistory().
 */
export function runStatusColor(status: string): string {
  if (status === 'success') return '#10B981';
  if (status === 'skipped_dedup') return '#94A3B8';
  return '#EF4444';
}

/**
 * Short run_id label: first 8 chars + '…'. Empty string if no run_id.
 * Mirrors the run-id span in loadRunHistory().
 */
export function runIdShort(meta?: CronMetadata | null): string {
  return meta?.run_id ? meta.run_id.slice(0, 8) + '…' : '';
}

/**
 * Items detected label. Empty string if items_detected is undefined.
 * Mirrors the items_detected span in loadRunHistory().
 */
export function itemsDetectedLabel(meta?: CronMetadata | null): string {
  if (meta && meta.items_detected !== undefined) {
    return meta.items_detected + ' item(s)';
  }
  return '';
}

// ── Security: URL guard ──────────────────────────────────────────────────────

/**
 * Returns true only for URLs with an http:// or https:// scheme (case-insensitive).
 * Rejects javascript:, data:, relative URLs, empty strings, null, etc.
 *
 * Used to guard source_url before rendering as an <a href>.
 * If this returns false the value is rendered as plain text (or "No URL").
 * Mirrors isSafeHttpUrl from cert-verifications/utils.ts; §6.1 XSS guard.
 */
export function isSafeHttpUrl(url?: string | null): boolean {
  return /^https?:\/\//i.test(url || '');
}

// ── Diff discriminated union ──────────────────────────────────────────────────

export type DriftDiff =
  | { kind: 'no_source'; tiers: string[] }
  | { kind: 'deprecated'; current: string }
  | { kind: 'modified'; current: string; proposed: string }
  | { kind: 'added'; proposed: string }
  | { kind: 'none' };

/**
 * Compute the display diff for a drift row.
 * Mirrors buildDiffHtml() in admin-warranty-drift.html — same branching logic,
 * returns plain data instead of HTML strings.
 *
 *   no_source  → tiers list from current_value.tiers (tier || display_string || '')
 *   deprecated → current display_string || program_name || 'Program'
 *   modified (with proposed_value) → current + proposed display strings
 *   added      → proposed display string
 *   default / modified-without-proposed → kind:'none'
 */
export function buildDiff(row: DriftRow): DriftDiff {
  const cur = row.current_value || {};
  const prop = row.proposed_value || {};

  if (row.change_type === 'no_source') {
    const tiers = (cur.tiers || []).map(
      (t) => t.tier || t.display_string || '',
    );
    return { kind: 'no_source', tiers };
  }

  if (row.change_type === 'deprecated') {
    const current = cur.display_string || cur.program_name || 'Program';
    return { kind: 'deprecated', current };
  }

  if (row.change_type === 'modified' && row.proposed_value) {
    const current = cur.display_string || JSON.stringify(cur);
    const proposed = prop.display_string || JSON.stringify(prop);
    return { kind: 'modified', current, proposed };
  }

  if (row.change_type === 'added') {
    const proposed = prop.display_string || JSON.stringify(prop);
    return { kind: 'added', proposed };
  }

  return { kind: 'none' };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Reject reason is valid when it has at least one non-whitespace character.
 * NOTE: warranty drift source requires only non-empty (NOT the 5-char minimum
 * used by payouts). Mirrors confirmReject() check in admin-warranty-drift.html.
 */
export function isRejectReasonValid(reason?: string | null): boolean {
  return (reason ?? '').trim().length > 0;
}

/**
 * Returns true when both displayString and programName trim to empty — signals
 * that confirmApproveEdit() should call SKIP instead of approve-with-changes.
 * Mirrors the if (!displayString && !programName) guard in confirmApproveEdit().
 */
export function isApproveEditSkip(displayString: string, programName: string): boolean {
  return displayString.trim() === '' && programName.trim() === '';
}

/**
 * Build the proposed_value object for approve-with-changes.
 * Includes display_string and/or program_name only when trimmed non-empty.
 * Values are trimmed. Mirrors the proposedValue build in confirmApproveEdit().
 */
export function buildProposedValue(
  displayString: string,
  programName: string,
): DriftProposedValue {
  const result: DriftProposedValue = {};
  const ds = displayString.trim();
  const pn = programName.trim();
  if (ds) result.display_string = ds;
  if (pn) result.program_name = pn;
  return result;
}

// ── EF payload builders — UNCHANGED CONTRACTS (Tier-3) ───────────────────────

export interface ApprovePayload {
  drift_id: string;
}

export interface ApproveWithChangesPayload {
  drift_id: string;
  proposed_value: DriftProposedValue;
}

export interface RejectPayload {
  drift_id: string;
  action: 'reject';
  rejection_reason: string;
}

export interface SkipPayload {
  drift_id: string;
  action: 'skip';
}

/** Union of every EF payload shape sent from this page (Tier-3 contracts). */
export type WarrantyEfPayload =
  | ApprovePayload
  | ApproveWithChangesPayload
  | RejectPayload
  | SkipPayload;

/**
 * Build approve-warranty-drift EF payload (normal, non-no_source rows).
 * Field names UNCHANGED from admin-warranty-drift.html callEF() body.
 */
export function approvePayload(driftId: string): ApprovePayload {
  return { drift_id: driftId };
}

/**
 * Build approve-warranty-drift EF payload with proposed_value (no_source rows).
 * Field names UNCHANGED from admin-warranty-drift.html confirmApproveEdit() callEF() body.
 */
export function approveWithChangesPayload(
  driftId: string,
  displayString: string,
  programName: string,
): ApproveWithChangesPayload {
  return {
    drift_id: driftId,
    proposed_value: buildProposedValue(displayString, programName),
  };
}

/**
 * Build reject-warranty-drift EF payload (rejection action).
 * Field names UNCHANGED from admin-warranty-drift.html confirmReject() callEF() body.
 */
export function rejectPayload(driftId: string, reason: string): RejectPayload {
  return { drift_id: driftId, action: 'reject', rejection_reason: reason };
}

/**
 * Build reject-warranty-drift EF payload (skip action).
 * Field names UNCHANGED from admin-warranty-drift.html skipDrift() callEF() body.
 */
export function skipPayload(driftId: string): SkipPayload {
  return { drift_id: driftId, action: 'skip' };
}
