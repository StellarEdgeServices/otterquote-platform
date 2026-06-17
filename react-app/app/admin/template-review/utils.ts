/**
 * Admin Template Review — pure logic (D-211 Phase 9 / A6).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Mirrors admin-template-review.html behavior 1:1.
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering in
 * page.tsx is inherently escaped. No HTML strings built here.
 */

// ── Data model ───────────────────────────────────────────────────────────────

export interface TemplateAnchor {
  anchor: string;
  field: string;
  found?: boolean;
  manualOverride?: boolean;
}

export interface ValidationResult {
  requiredFoundCount?: number;
  requiredCount?: number;
  anchors?: TemplateAnchor[];
  [k: string]: unknown;
}

export interface TemplateContractor {
  id: string;
  company_name: string | null;
  email: string | null;
  contact_name: string | null;
}

export interface TemplateRow {
  id: string;
  contractor_id: string;
  trade: string;
  funding_type: string;
  status: string;
  pdf_storage_path: string;
  validation_result?: ValidationResult | null;
  admin_notes?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  contractors?: TemplateContractor | null;
}

// ── Filter tabs ──────────────────────────────────────────────────────────────

export type TemplateFilter =
  | 'needs_review'
  | 'all'
  | 'submitted_for_admin_review'
  | 'manual_mapping_pending'
  | 'auto_validated'
  | 'manual_validated'
  | 'admin_validated'
  | 'rejected';

export const TEMPLATE_FILTERS: { key: TemplateFilter; label: string }[] = [
  { key: 'needs_review', label: 'Needs Review' },
  { key: 'all', label: 'All' },
  { key: 'submitted_for_admin_review', label: 'Submitted' },
  { key: 'manual_mapping_pending', label: 'Mapping Pending' },
  { key: 'auto_validated', label: 'Auto-Validated' },
  { key: 'manual_validated', label: 'Manual-Validated' },
  { key: 'admin_validated', label: 'Admin-Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const NEEDS_REVIEW_STATUSES = ['submitted_for_admin_review', 'manual_mapping_pending'];

/**
 * Filter rows for the active tab. Mirrors renderTable()'s `filtered` logic
 * in admin-template-review.html.
 */
export function filteredTemplates(
  filter: TemplateFilter,
  rows: TemplateRow[],
): TemplateRow[] {
  if (filter === 'all') return rows;
  if (filter === 'needs_review') {
    return rows.filter((t) => NEEDS_REVIEW_STATUSES.includes(t.status));
  }
  return rows.filter((t) => t.status === filter);
}

// ── Summary counts ───────────────────────────────────────────────────────────

export interface TemplateSummaryCounts {
  awaiting: number;
  auto: number;
  manual: number;
  rejected: number;
}

/**
 * Compute the 4 summary card counts over ALL rows. Mirrors updateSummaryCards():
 *   awaiting = submitted_for_admin_review + manual_mapping_pending
 */
export function summaryCounts(rows: TemplateRow[]): TemplateSummaryCounts {
  const c = (s: string) => rows.filter((t) => t.status === s).length;
  return {
    awaiting: c('submitted_for_admin_review') + c('manual_mapping_pending'),
    auto: c('auto_validated'),
    manual: c('manual_validated'),
    rejected: c('rejected'),
  };
}

// ── Status badge ─────────────────────────────────────────────────────────────

export interface StatusBadge {
  cls: string;
  label: string;
}

const STATUS_BADGE_MAP: Record<string, StatusBadge> = {
  pending_validation: { cls: 'status-pending', label: 'Pending Validation' },
  auto_validated: { cls: 'status-validated', label: 'Auto-Validated' },
  manual_mapping_pending: { cls: 'status-mapping', label: 'Mapping Pending' },
  manual_validated: { cls: 'status-validated', label: 'Manual-Validated' },
  submitted_for_admin_review: { cls: 'status-admin', label: 'Awaiting Admin' },
  admin_validated: { cls: 'status-validated', label: 'Admin-Approved' },
  rejected: { cls: 'status-rejected', label: 'Rejected' },
};

/**
 * Map a status to its badge {cls,label}. Unknown statuses fall back to
 * {cls:'status-pending', label:status}. Mirrors statusBadge() in the static page.
 */
export function statusBadge(status: string): StatusBadge {
  return STATUS_BADGE_MAP[status] || { cls: 'status-pending', label: status };
}

// ── Anchors-found summary (table cell) ───────────────────────────────────────

export type AnchorSummary =
  | { validated: true; found: number; total: number; label: string }
  | { validated: false; label: '— not yet validated —' };

/**
 * Summarize the anchors-found count for the table cell. Mirrors the tdAnchors
 * branch in renderTable(): when requiredFoundCount and requiredCount are both
 * numbers → "{found} / {total} required found"; otherwise → "— not yet validated —".
 */
export function anchorSummary(
  validationResult: ValidationResult | null | undefined,
): AnchorSummary {
  const vr = validationResult || {};
  const found = vr.requiredFoundCount;
  const total = vr.requiredCount;
  if (typeof found === 'number' && typeof total === 'number') {
    return { validated: true, found, total, label: `${found} / ${total} required found` };
  }
  return { validated: false, label: '— not yet validated —' };
}

// ── Drawer anchor list (detail drawer) ───────────────────────────────────────

export interface AnchorListRow {
  anchor: string;
  field: string;
  found: boolean;
  rightText: 'mapped manually' | 'found' | 'missing';
  rowClass: 'found' | 'missing';
}

export interface AnchorList {
  headingFound: number;
  headingTotal: number;
  rows: AnchorListRow[];
}

/**
 * Build the drawer's required-anchor list. Mirrors the anchor-grid block in
 * openDrawer(): heading "Required Anchors (requiredFoundCount ?? 0 /
 * requiredCount ?? 0)" and one row per anchor with the found/manualOverride →
 * label + row-class logic. Returns rows:[] when there are no anchors (the page
 * renders the block only when rows.length > 0).
 */
export function buildAnchorList(
  validationResult: ValidationResult | null | undefined,
): AnchorList {
  const vr = validationResult || {};
  const anchors = vr.anchors || [];
  return {
    headingFound: vr.requiredFoundCount ?? 0,
    headingTotal: vr.requiredCount ?? 0,
    rows: anchors.map((a) => {
      const found = !!a.found;
      return {
        anchor: a.anchor,
        field: a.field,
        found,
        rightText: found ? (a.manualOverride ? 'mapped manually' : 'found') : 'missing',
        rowClass: found ? 'found' : 'missing',
      };
    }),
  };
}

// ── Drawer title ─────────────────────────────────────────────────────────────

/**
 * Drawer header title. Mirrors openDrawer()'s drawerTitle assignment:
 *   "{company_name || '(unknown)'} — {trade} × {funding_type}".
 */
export function drawerTitle(row: TemplateRow): string {
  const company = row.contractors?.company_name || '(unknown)';
  return `${company} — ${row.trade} × ${row.funding_type}`;
}

// ── Write payloads (DIRECT contractor_templates UPDATE — no Edge Function) ────

export interface ApproveUpdatePayload {
  status: 'admin_validated';
  reviewed_by: string;
  reviewed_at: string;
  admin_notes: '(approved without notes)';
}

/**
 * Build the UPDATE payload for approving a template as admin-validated. `now`
 * injectable for deterministic tests. Mirrors approveTemplate()'s update object
 * with UNCHANGED field values. reviewed_by = admin user.id (NOT email — A6
 * differs from A5 here).
 */
export function buildApproveUpdate(
  userId: string,
  now: Date = new Date(),
): ApproveUpdatePayload {
  return {
    status: 'admin_validated',
    reviewed_by: userId,
    reviewed_at: now.toISOString(),
    admin_notes: '(approved without notes)',
  };
}

export interface RejectUpdatePayload {
  status: 'rejected';
  reviewed_by: string;
  reviewed_at: string;
  admin_notes: string;
}

/**
 * Build the UPDATE payload for rejecting a template. `reason` is the (already
 * trimmed + non-empty-validated by the page) rejection reason, stored verbatim
 * in admin_notes. Mirrors rejectTemplate()'s update object. reviewed_by = user.id.
 */
export function buildRejectUpdate(
  userId: string,
  reason: string,
  now: Date = new Date(),
): RejectUpdatePayload {
  return {
    status: 'rejected',
    reviewed_by: userId,
    reviewed_at: now.toISOString(),
    admin_notes: reason,
  };
}
