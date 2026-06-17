/**
 * Admin Cert Verifications — pure logic (D-211 Phase 9).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Mirrors admin-cert-verifications.html behavior 1:1.
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering
 * in page.tsx is inherently escaped. No HTML strings built here.
 */

// ── Data model ───────────────────────────────────────────────────────────────

export interface CertVerificationRow {
  id: string;
  contractor_id: string;
  manufacturer: string;
  cert_name: string;
  status: string;
  source: string;
  source_url?: string | null;
  evidence_storage_path?: string | null;
  verified_at?: string | null;
  expires_at?: string | null;
  notes?: string | null;
  reviewed_by_admin?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  contractors?: { id: string; company_name: string | null } | null;
}

// ── Filter tabs ──────────────────────────────────────────────────────────────

export type CertFilter =
  | 'needs_review'
  | 'pending'
  | 'scrape_failed'
  | 'blocked_by_robots'
  | 'verified'
  | 'rejected'
  | 'all';

export const CERT_FILTERS: { key: CertFilter; label: string }[] = [
  { key: 'needs_review', label: 'Needs Review' },
  { key: 'pending', label: 'Pending Upload' },
  { key: 'scrape_failed', label: 'Scrape Failed' },
  { key: 'blocked_by_robots', label: 'Blocked' },
  { key: 'verified', label: 'Verified' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

/**
 * Filter rows for the active tab. Mirrors rowsForFilter() in the static page.
 */
export function rowsForFilter(
  filter: CertFilter,
  rows: CertVerificationRow[],
): CertVerificationRow[] {
  if (filter === 'all') return rows;
  if (filter === 'needs_review') {
    return rows.filter((r) =>
      ['pending', 'scrape_failed', 'blocked_by_robots'].includes(r.status),
    );
  }
  return rows.filter((r) => r.status === filter);
}

// ── Summary counts ───────────────────────────────────────────────────────────

export interface CertSummaryCounts {
  pending: number;
  scrape_failed: number;
  blocked_by_robots: number;
  verified: number;
}

/**
 * Compute the 4 summary card counts over ALL rows (not filtered).
 * Mirrors the four getElementById('card*Count') assignments in the static page.
 */
export function summaryCounts(rows: CertVerificationRow[]): CertSummaryCounts {
  return {
    pending: rows.filter((r) => r.status === 'pending').length,
    scrape_failed: rows.filter((r) => r.status === 'scrape_failed').length,
    blocked_by_robots: rows.filter((r) => r.status === 'blocked_by_robots').length,
    verified: rows.filter((r) => r.status === 'verified').length,
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────

/**
 * Status label: replace underscores with spaces.
 * e.g. 'scrape_failed' → 'scrape failed', 'blocked_by_robots' → 'blocked by robots'.
 */
export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

// ── Security: URL guard ──────────────────────────────────────────────────────

/**
 * Returns true only for URLs with an http:// or https:// scheme (case-insensitive).
 * Rejects javascript:, data:, relative URLs, empty strings, etc.
 *
 * Used to guard source_url before rendering as an <a href>.
 * If this returns false the value is rendered as plain text.
 */
export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

// ── Approve insert payload ───────────────────────────────────────────────────

export interface ApproveInsertPayload {
  contractor_id: string;
  manufacturer: string;
  cert_name: string;
  status: 'verified';
  source: 'admin_review';
  source_url: string | null;
  evidence_storage_path: string | null;
  verified_at: string;
  expires_at: string;
  reviewed_by_admin: string;
  notes: 'Admin approved from review queue.';
}

/**
 * Build the INSERT payload for approving a cert verification.
 *
 * `now` is injectable for deterministic tests (default: new Date()).
 * expires_at = now + 365 days exactly.
 *
 * Mirrors approveRow() in admin-cert-verifications.html with UNCHANGED field values.
 */
export function buildApproveInsert(
  row: CertVerificationRow,
  adminEmail: string | null | undefined,
  now: Date = new Date(),
): ApproveInsertPayload {
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  return {
    contractor_id: row.contractor_id,
    manufacturer: row.manufacturer,
    cert_name: row.cert_name,
    status: 'verified',
    source: 'admin_review',
    source_url: row.source_url || null,
    evidence_storage_path: row.evidence_storage_path || null,
    verified_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    reviewed_by_admin: adminEmail || 'admin',
    notes: 'Admin approved from review queue.',
  };
}

// ── Reject insert payload ────────────────────────────────────────────────────

export interface RejectInsertPayload {
  contractor_id: string;
  manufacturer: string;
  cert_name: string;
  status: 'rejected';
  source: 'admin_review';
  reviewed_by_admin: string;
  notes: string;
}

/**
 * Build the INSERT payload for rejecting a cert verification.
 *
 * If `reason` is empty/falsy, notes falls back to 'Rejected by admin.'
 *
 * Mirrors rejectRow() in admin-cert-verifications.html with UNCHANGED field values.
 */
export function buildRejectInsert(
  row: CertVerificationRow,
  adminEmail: string | null | undefined,
  reason: string | null | undefined,
): RejectInsertPayload {
  return {
    contractor_id: row.contractor_id,
    manufacturer: row.manufacturer,
    cert_name: row.cert_name,
    status: 'rejected',
    source: 'admin_review',
    reviewed_by_admin: adminEmail || 'admin',
    notes: reason || 'Rejected by admin.',
  };
}
