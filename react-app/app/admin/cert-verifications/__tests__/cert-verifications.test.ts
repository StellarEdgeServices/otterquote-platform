/**
 * Unit + parity tests for Admin Cert Verifications pure logic (D-211 Phase 9).
 *
 * Pins rowsForFilter (all 7 tabs), summaryCounts (4 cards), statusLabel,
 * isSafeHttpUrl, buildApproveInsert, and buildRejectInsert against
 * admin-cert-verifications.html @ main behavior.
 *
 * No network / supabase calls — all helpers are side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import {
  type CertVerificationRow,
  rowsForFilter,
  summaryCounts,
  statusLabel,
  isSafeHttpUrl,
  buildApproveInsert,
  buildRejectInsert,
  CERT_FILTERS,
} from '../utils';

// ── Fixture ──────────────────────────────────────────────────────────────────

function mkRow(over: Partial<CertVerificationRow> = {}): CertVerificationRow {
  return {
    id: over.id ?? 'r1',
    contractor_id: over.contractor_id ?? 'c-001',
    manufacturer: over.manufacturer ?? 'Acme Mfg',
    cert_name: over.cert_name ?? 'Solar PV Basic',
    status: over.status ?? 'pending',
    source: over.source ?? 'manual',
    source_url: over.source_url ?? null,
    evidence_storage_path: over.evidence_storage_path ?? null,
    created_at: over.created_at ?? '2026-06-01T00:00:00Z',
    notes: over.notes ?? null,
    ...over,
  };
}

// One row per distinct status so all filter branches are exercised
const ALL_ROWS: CertVerificationRow[] = [
  mkRow({ id: 'r-pending', status: 'pending' }),
  mkRow({ id: 'r-scrape', status: 'scrape_failed' }),
  mkRow({ id: 'r-blocked', status: 'blocked_by_robots' }),
  mkRow({ id: 'r-verified', status: 'verified' }),
  mkRow({ id: 'r-rejected', status: 'rejected' }),
];

// ── CERT_FILTERS order ───────────────────────────────────────────────────────

describe('CERT_FILTERS', () => {
  it('exposes the 7 tabs in the correct order', () => {
    expect(CERT_FILTERS.map((f) => f.key)).toEqual([
      'needs_review',
      'pending',
      'scrape_failed',
      'blocked_by_robots',
      'verified',
      'rejected',
      'all',
    ]);
  });
});

// ── rowsForFilter ─────────────────────────────────────────────────────────────

describe('rowsForFilter', () => {
  it('needs_review = pending + scrape_failed + blocked_by_robots (3-status union)', () => {
    const result = rowsForFilter('needs_review', ALL_ROWS);
    expect(result.map((r) => r.id).sort()).toEqual(['r-blocked', 'r-pending', 'r-scrape'].sort());
  });

  it('pending = only status===pending', () => {
    expect(rowsForFilter('pending', ALL_ROWS).map((r) => r.id)).toEqual(['r-pending']);
  });

  it('scrape_failed = only status===scrape_failed', () => {
    expect(rowsForFilter('scrape_failed', ALL_ROWS).map((r) => r.id)).toEqual(['r-scrape']);
  });

  it('blocked_by_robots = only status===blocked_by_robots', () => {
    expect(rowsForFilter('blocked_by_robots', ALL_ROWS).map((r) => r.id)).toEqual(['r-blocked']);
  });

  it('verified = only status===verified', () => {
    expect(rowsForFilter('verified', ALL_ROWS).map((r) => r.id)).toEqual(['r-verified']);
  });

  it('rejected = only status===rejected', () => {
    expect(rowsForFilter('rejected', ALL_ROWS).map((r) => r.id)).toEqual(['r-rejected']);
  });

  it('all = every row', () => {
    expect(rowsForFilter('all', ALL_ROWS)).toHaveLength(5);
    expect(rowsForFilter('all', ALL_ROWS)).toEqual(ALL_ROWS);
  });

  it('needs_review excludes verified and rejected', () => {
    const result = rowsForFilter('needs_review', ALL_ROWS);
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain('r-verified');
    expect(ids).not.toContain('r-rejected');
  });

  it('returns empty array on empty input', () => {
    expect(rowsForFilter('needs_review', [])).toHaveLength(0);
    expect(rowsForFilter('all', [])).toHaveLength(0);
  });
});

// ── summaryCounts ─────────────────────────────────────────────────────────────

describe('summaryCounts', () => {
  it('counts all 4 card values correctly over the full fixture', () => {
    expect(summaryCounts(ALL_ROWS)).toEqual({
      pending: 1,
      scrape_failed: 1,
      blocked_by_robots: 1,
      verified: 1,
    });
  });

  it('returns zeros for an empty array', () => {
    expect(summaryCounts([])).toEqual({
      pending: 0,
      scrape_failed: 0,
      blocked_by_robots: 0,
      verified: 0,
    });
  });

  it('counts multiple rows of the same status', () => {
    const rows = [
      mkRow({ status: 'pending' }),
      mkRow({ status: 'pending' }),
      mkRow({ status: 'verified' }),
    ];
    expect(summaryCounts(rows)).toMatchObject({ pending: 2, verified: 1 });
  });
});

// ── statusLabel ───────────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it('replaces underscores with spaces', () => {
    expect(statusLabel('scrape_failed')).toBe('scrape failed');
    expect(statusLabel('blocked_by_robots')).toBe('blocked by robots');
    expect(statusLabel('pending')).toBe('pending');
    expect(statusLabel('verified')).toBe('verified');
    expect(statusLabel('rejected')).toBe('rejected');
  });
});

// ── isSafeHttpUrl ─────────────────────────────────────────────────────────────

describe('isSafeHttpUrl', () => {
  it('accepts http:// and https:// (case-insensitive)', () => {
    expect(isSafeHttpUrl('https://example.com')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('HTTPS://example.com')).toBe(true);
    expect(isSafeHttpUrl('HTTP://example.com')).toBe(true);
  });

  it('rejects javascript: scheme', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(1)')).toBe(false);
  });

  it('rejects data: scheme', () => {
    expect(isSafeHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
  });

  it('rejects relative URLs', () => {
    expect(isSafeHttpUrl('/path/to/page')).toBe(false);
    expect(isSafeHttpUrl('../../evil')).toBe(false);
  });

  it('rejects empty string and null/undefined', () => {
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });
});

// ── buildApproveInsert ────────────────────────────────────────────────────────

describe('buildApproveInsert', () => {
  const fixedNow = new Date('2026-06-17T12:00:00.000Z');
  const expected365 = new Date(fixedNow.getTime() + 365 * 24 * 60 * 60 * 1000);

  it('builds the correct shape with all fields present', () => {
    const row = mkRow({
      contractor_id: 'ctr-abc',
      manufacturer: 'SolarEdge',
      cert_name: 'Installer L1',
      source_url: 'https://cert.solar.com/verify',
      evidence_storage_path: 'cert-letters/2026/abc.pdf',
    });
    const result = buildApproveInsert(row, 'dustinstohler1@gmail.com', fixedNow);
    expect(result).toEqual({
      contractor_id: 'ctr-abc',
      manufacturer: 'SolarEdge',
      cert_name: 'Installer L1',
      status: 'verified',
      source: 'admin_review',
      source_url: 'https://cert.solar.com/verify',
      evidence_storage_path: 'cert-letters/2026/abc.pdf',
      verified_at: fixedNow.toISOString(),
      expires_at: expected365.toISOString(),
      reviewed_by_admin: 'dustinstohler1@gmail.com',
      notes: 'Admin approved from review queue.',
    });
  });

  it('coerces null/empty source_url → null', () => {
    expect(buildApproveInsert(mkRow({ source_url: null }), 'a@b.com', fixedNow).source_url).toBeNull();
    expect(buildApproveInsert(mkRow({ source_url: '' }), 'a@b.com', fixedNow).source_url).toBeNull();
  });

  it('coerces null/empty evidence_storage_path → null', () => {
    expect(buildApproveInsert(mkRow({ evidence_storage_path: null }), 'a@b.com', fixedNow).evidence_storage_path).toBeNull();
    expect(buildApproveInsert(mkRow({ evidence_storage_path: '' }), 'a@b.com', fixedNow).evidence_storage_path).toBeNull();
  });

  it('falls back to "admin" when adminEmail is falsy', () => {
    expect(buildApproveInsert(mkRow(), null, fixedNow).reviewed_by_admin).toBe('admin');
    expect(buildApproveInsert(mkRow(), '', fixedNow).reviewed_by_admin).toBe('admin');
    expect(buildApproveInsert(mkRow(), undefined, fixedNow).reviewed_by_admin).toBe('admin');
  });

  it('verified_at is exactly fixedNow.toISOString()', () => {
    expect(buildApproveInsert(mkRow(), 'a@b.com', fixedNow).verified_at).toBe(fixedNow.toISOString());
  });

  it('expires_at is exactly now + 365 days', () => {
    expect(buildApproveInsert(mkRow(), 'a@b.com', fixedNow).expires_at).toBe(expected365.toISOString());
  });

  it('notes is EXACTLY the required string', () => {
    expect(buildApproveInsert(mkRow(), 'a@b.com', fixedNow).notes).toBe(
      'Admin approved from review queue.',
    );
  });
});

// ── buildRejectInsert ─────────────────────────────────────────────────────────

describe('buildRejectInsert', () => {
  it('builds the correct shape with a real reason', () => {
    const row = mkRow({
      contractor_id: 'ctr-xyz',
      manufacturer: 'Enphase',
      cert_name: 'IQ8 Certified',
    });
    const result = buildRejectInsert(row, 'dustinstohler1@gmail.com', 'Certificate expired');
    expect(result).toEqual({
      contractor_id: 'ctr-xyz',
      manufacturer: 'Enphase',
      cert_name: 'IQ8 Certified',
      status: 'rejected',
      source: 'admin_review',
      reviewed_by_admin: 'dustinstohler1@gmail.com',
      notes: 'Certificate expired',
    });
  });

  it('falls back to "Rejected by admin." when reason is empty string', () => {
    expect(buildRejectInsert(mkRow(), 'a@b.com', '').notes).toBe('Rejected by admin.');
  });

  it('falls back to "Rejected by admin." when reason is null', () => {
    expect(buildRejectInsert(mkRow(), 'a@b.com', null).notes).toBe('Rejected by admin.');
  });

  it('falls back to "Rejected by admin." when reason is undefined', () => {
    expect(buildRejectInsert(mkRow(), 'a@b.com', undefined).notes).toBe('Rejected by admin.');
  });

  it('passes a real reason through unchanged', () => {
    const reason = 'Looks like a template, not a real cert.';
    expect(buildRejectInsert(mkRow(), 'a@b.com', reason).notes).toBe(reason);
  });

  it('falls back reviewed_by_admin to "admin" when email is falsy', () => {
    expect(buildRejectInsert(mkRow(), null, 'reason').reviewed_by_admin).toBe('admin');
    expect(buildRejectInsert(mkRow(), '', 'reason').reviewed_by_admin).toBe('admin');
    expect(buildRejectInsert(mkRow(), undefined, 'reason').reviewed_by_admin).toBe('admin');
  });
});
