/**
 * Unit + parity tests for Admin Template Review pure logic (D-211 Phase 9 / A6).
 *
 * Pins filteredTemplates (all 8 tabs), summaryCounts (4 cards), statusBadge
 * (7 statuses + fallback), anchorSummary (both branches), buildAnchorList,
 * drawerTitle, buildApproveUpdate, and buildRejectUpdate against
 * admin-template-review.html @ main behavior. No network / supabase calls.
 */

import { describe, it, expect } from 'vitest';
import {
  type TemplateRow,
  TEMPLATE_FILTERS,
  filteredTemplates,
  summaryCounts,
  statusBadge,
  anchorSummary,
  buildAnchorList,
  drawerTitle,
  buildApproveUpdate,
  buildRejectUpdate,
} from '../utils';

function mkRow(over: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: over.id ?? 't1',
    contractor_id: over.contractor_id ?? 'c-001',
    trade: over.trade ?? 'Roofing',
    funding_type: over.funding_type ?? 'Insurance',
    status: over.status ?? 'submitted_for_admin_review',
    pdf_storage_path: over.pdf_storage_path ?? 'contractor-templates/c-001/t1.pdf',
    validation_result: over.validation_result ?? null,
    contractors: over.contractors ?? {
      id: 'c-001',
      company_name: 'Acme Roofing',
      email: 'a@acme.com',
      contact_name: 'Al',
    },
    updated_at: over.updated_at ?? '2026-06-01T00:00:00Z',
    created_at: over.created_at ?? '2026-05-01T00:00:00Z',
    ...over,
  };
}

const ALL_STATUSES = [
  'pending_validation',
  'auto_validated',
  'manual_mapping_pending',
  'manual_validated',
  'submitted_for_admin_review',
  'admin_validated',
  'rejected',
];

const ALL_ROWS: TemplateRow[] = ALL_STATUSES.map((s) => mkRow({ id: 'r-' + s, status: s }));

describe('TEMPLATE_FILTERS', () => {
  it('exposes the 8 tabs in the correct order', () => {
    expect(TEMPLATE_FILTERS.map((f) => f.key)).toEqual([
      'needs_review',
      'all',
      'submitted_for_admin_review',
      'manual_mapping_pending',
      'auto_validated',
      'manual_validated',
      'admin_validated',
      'rejected',
    ]);
  });
  it('labels match the static page', () => {
    expect(TEMPLATE_FILTERS.map((f) => f.label)).toEqual([
      'Needs Review',
      'All',
      'Submitted',
      'Mapping Pending',
      'Auto-Validated',
      'Manual-Validated',
      'Admin-Approved',
      'Rejected',
    ]);
  });
});

describe('filteredTemplates', () => {
  it('all → every row', () => {
    expect(filteredTemplates('all', ALL_ROWS)).toEqual(ALL_ROWS);
    expect(filteredTemplates('all', ALL_ROWS)).toHaveLength(7);
  });
  it('needs_review → submitted_for_admin_review + manual_mapping_pending (2-status union)', () => {
    const ids = filteredTemplates('needs_review', ALL_ROWS).map((r) => r.id).sort();
    expect(ids).toEqual(['r-manual_mapping_pending', 'r-submitted_for_admin_review'].sort());
  });
  it('needs_review excludes all other statuses', () => {
    const ids = filteredTemplates('needs_review', ALL_ROWS).map((r) => r.id);
    ['r-auto_validated', 'r-manual_validated', 'r-admin_validated', 'r-rejected', 'r-pending_validation'].forEach(
      (id) => expect(ids).not.toContain(id),
    );
  });
  it('each single-status tab returns only that status', () => {
    (
      [
        'submitted_for_admin_review',
        'manual_mapping_pending',
        'auto_validated',
        'manual_validated',
        'admin_validated',
        'rejected',
      ] as const
    ).forEach((s) => {
      const res = filteredTemplates(s, ALL_ROWS);
      expect(res).toHaveLength(1);
      expect(res[0].status).toBe(s);
    });
  });
  it('returns empty on empty input', () => {
    expect(filteredTemplates('needs_review', [])).toHaveLength(0);
    expect(filteredTemplates('all', [])).toHaveLength(0);
  });
});

describe('summaryCounts', () => {
  it('awaiting = submitted_for_admin_review + manual_mapping_pending', () => {
    const rows = [
      mkRow({ status: 'submitted_for_admin_review' }),
      mkRow({ status: 'submitted_for_admin_review' }),
      mkRow({ status: 'manual_mapping_pending' }),
      mkRow({ status: 'auto_validated' }),
      mkRow({ status: 'manual_validated' }),
      mkRow({ status: 'rejected' }),
      mkRow({ status: 'admin_validated' }),
    ];
    expect(summaryCounts(rows)).toEqual({ awaiting: 3, auto: 1, manual: 1, rejected: 1 });
  });
  it('zeros on empty', () => {
    expect(summaryCounts([])).toEqual({ awaiting: 0, auto: 0, manual: 0, rejected: 0 });
  });
});

describe('statusBadge', () => {
  it('maps all 7 known statuses', () => {
    expect(statusBadge('pending_validation')).toEqual({ cls: 'status-pending', label: 'Pending Validation' });
    expect(statusBadge('auto_validated')).toEqual({ cls: 'status-validated', label: 'Auto-Validated' });
    expect(statusBadge('manual_mapping_pending')).toEqual({ cls: 'status-mapping', label: 'Mapping Pending' });
    expect(statusBadge('manual_validated')).toEqual({ cls: 'status-validated', label: 'Manual-Validated' });
    expect(statusBadge('submitted_for_admin_review')).toEqual({ cls: 'status-admin', label: 'Awaiting Admin' });
    expect(statusBadge('admin_validated')).toEqual({ cls: 'status-validated', label: 'Admin-Approved' });
    expect(statusBadge('rejected')).toEqual({ cls: 'status-rejected', label: 'Rejected' });
  });
  it('falls back to {status-pending, label:status} for unknown', () => {
    expect(statusBadge('weird_unknown')).toEqual({ cls: 'status-pending', label: 'weird_unknown' });
  });
});

describe('anchorSummary', () => {
  it('both counts numeric → "x / y required found"', () => {
    expect(anchorSummary({ requiredFoundCount: 2, requiredCount: 3 })).toEqual({
      validated: true,
      found: 2,
      total: 3,
      label: '2 / 3 required found',
    });
  });
  it('missing counts → "— not yet validated —"', () => {
    expect(anchorSummary({}).label).toBe('— not yet validated —');
    expect(anchorSummary(null).label).toBe('— not yet validated —');
    expect(anchorSummary(undefined).label).toBe('— not yet validated —');
    expect(anchorSummary({ requiredFoundCount: 2 }).validated).toBe(false);
    expect(anchorSummary({ requiredCount: 3 }).validated).toBe(false);
  });
  it('zero counts are still validated (0 is a number)', () => {
    expect(anchorSummary({ requiredFoundCount: 0, requiredCount: 0 })).toEqual({
      validated: true,
      found: 0,
      total: 0,
      label: '0 / 0 required found',
    });
  });
});

describe('buildAnchorList', () => {
  it('maps found / manualOverride / missing to right text + row class', () => {
    const list = buildAnchorList({
      requiredFoundCount: 1,
      requiredCount: 2,
      anchors: [
        { anchor: '{{name}}', field: 'Customer name', found: true, manualOverride: false },
        { anchor: '{{total}}', field: 'Total', found: true, manualOverride: true },
        { anchor: '{{sig}}', field: 'Signature', found: false },
      ],
    });
    expect(list.headingFound).toBe(1);
    expect(list.headingTotal).toBe(2);
    expect(list.rows).toEqual([
      { anchor: '{{name}}', field: 'Customer name', found: true, rightText: 'found', rowClass: 'found' },
      { anchor: '{{total}}', field: 'Total', found: true, rightText: 'mapped manually', rowClass: 'found' },
      { anchor: '{{sig}}', field: 'Signature', found: false, rightText: 'missing', rowClass: 'missing' },
    ]);
  });
  it('no anchors → empty rows, heading defaults 0/0', () => {
    expect(buildAnchorList({})).toEqual({ headingFound: 0, headingTotal: 0, rows: [] });
    expect(buildAnchorList(null)).toEqual({ headingFound: 0, headingTotal: 0, rows: [] });
  });
});

describe('drawerTitle', () => {
  it('formats company — trade × funding', () => {
    expect(
      drawerTitle(
        mkRow({
          trade: 'Roofing',
          funding_type: 'Insurance',
          contractors: { id: 'c', company_name: 'Acme', email: '', contact_name: '' },
        }),
      ),
    ).toBe('Acme — Roofing × Insurance');
  });
  it('falls back to (unknown) when company missing', () => {
    expect(drawerTitle(mkRow({ contractors: null, trade: 'HVAC', funding_type: 'Cash' }))).toBe(
      '(unknown) — HVAC × Cash',
    );
  });
});

describe('buildApproveUpdate', () => {
  const fixedNow = new Date('2026-06-17T12:00:00.000Z');
  it('builds the exact admin_validated payload with reviewed_by = user.id', () => {
    expect(buildApproveUpdate('admin-uuid-123', fixedNow)).toEqual({
      status: 'admin_validated',
      reviewed_by: 'admin-uuid-123',
      reviewed_at: fixedNow.toISOString(),
      admin_notes: '(approved without notes)',
    });
  });
});

describe('buildRejectUpdate', () => {
  const fixedNow = new Date('2026-06-17T12:00:00.000Z');
  it('builds the exact rejected payload, admin_notes = reason, reviewed_by = user.id', () => {
    expect(buildRejectUpdate('admin-uuid-123', 'Anchors missing after manual mapping.', fixedNow)).toEqual({
      status: 'rejected',
      reviewed_by: 'admin-uuid-123',
      reviewed_at: fixedNow.toISOString(),
      admin_notes: 'Anchors missing after manual mapping.',
    });
  });
});
