/**
 * Unit + parity tests for the Admin Contractors ported pure logic (D-211 Phase 8).
 * Pins behavior against admin-contractors.html @ main: coiState, the six summary
 * counts, the five filter predicates, the D-210 document-badge derivation (incl.
 * WCE-1-EXEMPT + the D-218 license-or-attestation logic), header badges, service-
 * area + license-board-state derivation, the license-board URL map, the
 * admin-contractor-action payload builders, the cron ef-/job split + docusign meta,
 * alertTypeLabel / cronStatusBadge, timeAgo, and the waitlist grouping. Network / EF
 * / RPC calls live in the page + components, never in utils.
 */

import { describe, it, expect } from 'vitest';
import {
  type Contractor,
  coiState,
  summaryCounts,
  filterContractors,
  CONTRACTOR_FILTERS,
  cglDocBadge,
  wcDocBadge,
  licenseDocBadge,
  coiHeaderBadge,
  showPcTemplateBadge,
  showNoAttestationBadge,
  deriveServiceStates,
  deriveLicenseBoardState,
  licenseBoardUrl,
  LICENSE_BOARD_STATIC_URLS,
  profileChecklist,
  markLicenseVerifiedPayload,
  sendInsuranceVerificationPayload,
  markInsuranceVerifiedPayload,
  saveNotesPayload,
  approvePayload,
  rejectPayload,
  splitCronRows,
  efFunctionName,
  findDocusignRow,
  cronJobRows,
  parseDocusignMeta,
  alertTypeLabel,
  cronStatusBadge,
  timeAgo,
  firstMessageLine,
  groupWaitlistByState,
  statusLabel,
  formatAppliedDate,
} from '../utils';

// Local-midnight reference clock so day-deltas are timezone-stable.
const NOW = new Date('2026-06-17T12:00:00');

function mk(over: Partial<Contractor> = {}): Contractor {
  return { id: over.id ?? 'c1', status: over.status ?? 'active', created_at: '2026-06-01T00:00:00Z', ...over };
}

describe('coiState', () => {
  it('missing when no file or no expiry', () => {
    expect(coiState(mk({ coi_file_url: null, coi_expires_at: '2026-12-01' }), NOW)).toBe('missing');
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: null }), NOW)).toBe('missing');
  });
  it('expired when expiry is before today', () => {
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: '2026-06-01' }), NOW)).toBe('expired');
  });
  it('expiring within 30 days (inclusive of day 30)', () => {
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: '2026-06-20' }), NOW)).toBe('expiring');
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: '2026-07-17' }), NOW)).toBe('expiring'); // exactly 30d
  });
  it('current beyond 30 days', () => {
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: '2026-07-18' }), NOW)).toBe('current'); // 31d
    expect(coiState(mk({ coi_file_url: 'x.pdf', coi_expires_at: '2026-12-01' }), NOW)).toBe('current');
  });
});

describe('summaryCounts', () => {
  const list: Contractor[] = [
    mk({ id: 'a', status: 'pending_approval' }),
    mk({ id: 'b', status: 'active', pc_template_migration_pending: true }),
    mk({ id: 'c', status: 'active', coi_file_url: 'x', coi_expires_at: '2026-06-01' }), // expired
    mk({ id: 'd', status: 'inactive', coi_file_url: 'x', coi_expires_at: '2026-06-20' }), // expiring
    mk({ id: 'e', status: 'active' }), // no coi → missing
  ];
  it('counts pending/active/total/pc/coi as the source does', () => {
    const s = summaryCounts(list, NOW);
    expect(s).toEqual({
      pending: 1,
      active: 3,
      total: 5,
      pcMigration: 1,
      coiMissing: 4, // a,b,e missing + c expired
      coiExpiring: 1, // d
    });
  });
});

describe('filterContractors', () => {
  const list: Contractor[] = [
    mk({ id: 'p', status: 'pending_approval' }),
    mk({ id: 'a', status: 'active' }),
    mk({ id: 'pc', status: 'active', pc_template_migration_pending: true }),
    mk({ id: 'exp', status: 'active', coi_file_url: 'x', coi_expires_at: '2026-06-01' }),
    mk({ id: 'soon', status: 'active', coi_file_url: 'x', coi_expires_at: '2026-06-20' }),
  ];
  it('exposes exactly the five tabs in order', () => {
    expect(CONTRACTOR_FILTERS.map((f) => f.key)).toEqual([
      'pending_approval',
      'all',
      'pc_migration_pending',
      'coi_missing',
      'coi_expiring',
    ]);
  });
  it('pending_approval', () => {
    expect(filterContractors(list, 'pending_approval', NOW).map((c) => c.id)).toEqual(['p']);
  });
  it('all returns everything', () => {
    expect(filterContractors(list, 'all', NOW)).toHaveLength(5);
  });
  it('pc_migration_pending', () => {
    expect(filterContractors(list, 'pc_migration_pending', NOW).map((c) => c.id)).toEqual(['pc']);
  });
  it('coi_missing includes missing + expired', () => {
    expect(filterContractors(list, 'coi_missing', NOW).map((c) => c.id).sort()).toEqual(['a', 'exp', 'p', 'pc']);
  });
  it('coi_expiring only ≤30d', () => {
    expect(filterContractors(list, 'coi_expiring', NOW).map((c) => c.id)).toEqual(['soon']);
  });
});

describe('document badges (D-210)', () => {
  it('CGL: present vs missing', () => {
    expect(cglDocBadge(mk({ coi_file_url: 'x' }))).toMatchObject({ icon: '✅', color: '#166534' });
    expect(cglDocBadge(mk({ coi_file_url: null }))).toMatchObject({ icon: '❌', color: '#991b1b' });
  });
  it("WC: missing / present / WCE-1 exempt", () => {
    expect(wcDocBadge(mk({ wc_cert_file_ref: null }))).toMatchObject({ icon: '❌', text: "Workers' Comp" });
    expect(wcDocBadge(mk({ wc_cert_file_ref: 'file.pdf' }))).toMatchObject({ icon: '✅', text: "Workers' Comp" });
    expect(wcDocBadge(mk({ wc_cert_file_ref: 'WCE-1-EXEMPT' }))).toMatchObject({ icon: '🔷', text: 'WCE-1 Exempt', color: '#4f46e5' });
  });
  it('License D-218: doc, attestation-only, none', () => {
    // joined license rows → has doc → ✅ License
    expect(licenseDocBadge(mk({ contractor_licenses: [{ id: 'l', municipality: 'Marion', license_number: '123' }] })))
      .toMatchObject({ icon: '✅', text: 'License' });
    // license_path 'not_provided' with no doc → attestation-only → 📋 No License Req.
    expect(licenseDocBadge(mk({ license_path: 'not_provided', contractor_licenses: [] })))
      .toMatchObject({ icon: '📋', text: 'No License Req.' });
    // signed attestation but a real license_path doc → ✅ License (doc wins)
    expect(licenseDocBadge(mk({ license_path: 'docs/lic.pdf', license_attestation_signed_at: '2026-01-01' })))
      .toMatchObject({ icon: '✅', text: 'License' });
    // nothing → ❌ License
    expect(licenseDocBadge(mk({ license_path: null, contractor_licenses: [] }))).toMatchObject({ icon: '❌', text: 'License' });
  });
});

describe('header badges', () => {
  it('coiHeaderBadge maps state → pill (null when current)', () => {
    expect(coiHeaderBadge(mk({ coi_file_url: null }), NOW)?.text).toBe('⚠️ COI Missing');
    expect(coiHeaderBadge(mk({ coi_file_url: 'x', coi_expires_at: '2026-06-01' }), NOW)?.text).toBe('⚠️ COI Expired');
    expect(coiHeaderBadge(mk({ coi_file_url: 'x', coi_expires_at: '2026-06-20' }), NOW)?.text).toBe('COI ≤30d');
    expect(coiHeaderBadge(mk({ coi_file_url: 'x', coi_expires_at: '2026-12-01' }), NOW)).toBeNull();
  });
  it('pc-template badge is truthy-gated; attestation badge shows when absent', () => {
    expect(showPcTemplateBadge(mk({ pc_template_migration_pending: true }))).toBe(true);
    expect(showPcTemplateBadge(mk({ pc_template_migration_pending: false }))).toBe(false);
    expect(showNoAttestationBadge(mk({ attestation_accepted_at: null }))).toBe(true);
    expect(showNoAttestationBadge(mk({ attestation_accepted_at: '2026-01-01' }))).toBe(false);
  });
});

describe('service area + license board', () => {
  it('derives unique states from County-ST suffixes', () => {
    expect(deriveServiceStates(mk({ service_counties: ['Marion-IN', 'Lake-IN', 'Cook-IL', 'NoDash'] }))).toEqual(['IN', 'IL']);
    expect(deriveServiceStates(mk({ service_counties: [] }))).toEqual([]);
  });
  it('derives the primary license-board state (default IN)', () => {
    expect(deriveLicenseBoardState(mk({ service_counties: ['Cook-IL', 'Marion-IN'] }))).toBe('IL');
    expect(deriveLicenseBoardState(mk({ service_counties: ['NoDash'] }))).toBe('IN');
    expect(deriveLicenseBoardState(mk({ service_counties: [] }))).toBe('IN');
  });
  it('builds license-board URLs (IN query, static map, Google fallback)', () => {
    expect(licenseBoardUrl('IN', 'Acme & Co')).toBe(
      'https://www.in.gov/pla/licensing/find-a-licensee/?q=' + encodeURIComponent('Acme & Co'),
    );
    expect(licenseBoardUrl('OH', 'Acme')).toBe(LICENSE_BOARD_STATIC_URLS.OH);
    expect(licenseBoardUrl('ZZ', 'Acme')).toBe(
      'https://www.google.com/search?q=' + encodeURIComponent('Acme contractor license ZZ'),
    );
  });
});

describe('profileChecklist', () => {
  it('payment method is always incomplete; others reflect data', () => {
    const items = profileChecklist(
      mk({
        company_name: 'Acme',
        has_general_liability: true,
        service_counties: ['Marion-IN'],
        contract_templates: { roofing: {} },
        agreement_accepted_at: '2026-01-01',
      }),
    );
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.done]));
    expect(byLabel['Company information']).toBe(true);
    expect(byLabel['Insurance on file']).toBe(true);
    expect(byLabel['Service area']).toBe(true);
    expect(byLabel['Contract template']).toBe(true);
    expect(byLabel['Payment method']).toBe(false);
    expect(byLabel['Agreement accepted']).toBe(true);
  });
});

describe('admin-contractor-action payload builders (UNCHANGED contracts)', () => {
  it('mark_license_verified', () => {
    expect(markLicenseVerifiedPayload('c1')).toEqual({ action: 'mark_license_verified', contractor_id: 'c1' });
  });
  it('send_insurance_verification falls back to "Contractor"', () => {
    expect(sendInsuranceVerificationPayload('c1', 'b@x.com', 'Acme')).toEqual({
      action: 'send_insurance_verification',
      contractor_id: 'c1',
      broker_email: 'b@x.com',
      contractor_company_name: 'Acme',
    });
    expect(sendInsuranceVerificationPayload('c1', 'b@x.com', null).contractor_company_name).toBe('Contractor');
  });
  it('mark_insurance_verified', () => {
    expect(markInsuranceVerifiedPayload('c1')).toEqual({ action: 'mark_insurance_verified', contractor_id: 'c1' });
  });
  it('save_notes coerces empty → null', () => {
    expect(saveNotesPayload('c1', 'hi')).toEqual({ action: 'save_notes', contractor_id: 'c1', notes: 'hi' });
    expect(saveNotesPayload('c1', '').notes).toBeNull();
  });
  it('approve / reject', () => {
    expect(approvePayload('c1')).toEqual({ action: 'approve', contractor_id: 'c1' });
    expect(rejectPayload('c1', 'bad docs')).toEqual({ action: 'reject', contractor_id: 'c1', reason: 'bad docs' });
  });
});

describe('platform monitoring helpers', () => {
  const rows = [
    { job_name: 'ef-send-email', last_run_status: 'success', run_count: 4 },
    { job_name: 'ef-charge', last_run_status: 'error', last_error: 'boom' },
    { job_name: 'nightly-bids', last_run_status: 'success' },
    { job_name: 'docusign-usage', p_error: '{"used":32,"limit":40,"percentUsed":80,"alertSent":true}' },
  ];
  it('splits ef-* vs job rows; strips ef- prefix', () => {
    const { efRows, jobRows } = splitCronRows(rows);
    expect(efRows.map((r) => r.job_name)).toEqual(['ef-send-email', 'ef-charge']);
    expect(jobRows.map((r) => r.job_name)).toEqual(['nightly-bids', 'docusign-usage']);
    expect(efFunctionName('ef-send-email')).toBe('send-email');
  });
  it('isolates docusign + excludes it from the cron-job table', () => {
    const { jobRows } = splitCronRows(rows);
    expect(findDocusignRow(jobRows)?.job_name).toBe('docusign-usage');
    expect(cronJobRows(jobRows).map((r) => r.job_name)).toEqual(['nightly-bids']);
  });
  it('parses docusign meta + threshold bar colors', () => {
    expect(parseDocusignMeta({ job_name: 'docusign-usage', p_error: '{"used":32,"limit":40,"percentUsed":80,"alertSent":true}' }))
      .toEqual({ used: 32, limit: 40, pct: 80, alertSent: true, barColor: '#ef4444', barWidth: 80 });
    expect(parseDocusignMeta({ job_name: 'd', p_error: '{"percentUsed":60}' }).barColor).toBe('#f59e0b');
    expect(parseDocusignMeta({ job_name: 'd', p_error: '{"percentUsed":10}' }).barColor).toBe('#22c55e');
    // No percentUsed → blue bar, width 0, default limit 40, used em-dash
    expect(parseDocusignMeta({ job_name: 'd', p_error: '{}' })).toEqual({ used: '—', limit: 40, pct: null, alertSent: false, barColor: '#3b82f6', barWidth: 0 });
    // Invalid JSON → defaults, no throw
    expect(parseDocusignMeta({ job_name: 'd', p_error: 'not json' }).limit).toBe(40);
  });
  it('alertTypeLabel known + unknown fallback', () => {
    expect(alertTypeLabel('ef_silent_failure').text).toBe('EF FAILURE');
    expect(alertTypeLabel('rate_limit').color).toBe('#a5b4fc');
    expect(alertTypeLabel('mystery_type')).toEqual({ text: 'mystery_type', bg: '#1e293b', color: '#94a3b8' });
  });
  it('cronStatusBadge OK/ERROR/—', () => {
    expect(cronStatusBadge('success')).toMatchObject({ text: 'OK' });
    expect(cronStatusBadge('error', 'kaboom')).toMatchObject({ text: 'ERROR', title: 'kaboom' });
    expect(cronStatusBadge(null)).toMatchObject({ text: '—' });
  });
  it('firstMessageLine splits on the literal backslash-n sequence', () => {
    expect(firstMessageLine('first line\\nsecond line')).toBe('first line');
    expect(firstMessageLine('no breaks')).toBe('no breaks');
    expect(firstMessageLine(null)).toBe('');
  });
  it('timeAgo buckets', () => {
    const now = new Date('2026-06-17T12:00:00Z').getTime();
    expect(timeAgo(new Date(now - 30 * 1000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60000).toISOString(), now)).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3600000).toISOString(), now)).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 86400000).toISOString(), now)).toBe('2d ago');
  });
});

describe('waitlist grouping (D-178)', () => {
  it('groups by state (null → Unknown), counts opted-in, sorts by state', () => {
    expect(
      groupWaitlistByState([
        { state: 'OH', opted_in: true },
        { state: 'IN', opted_in: false },
        { state: 'IN', opted_in: true },
        { state: null, opted_in: true },
      ]),
    ).toEqual([
      { state: 'IN', total: 2, optedIn: 1 },
      { state: 'OH', total: 1, optedIn: 1 },
      { state: 'Unknown', total: 1, optedIn: 1 },
    ]);
    expect(groupWaitlistByState([])).toEqual([]);
  });
});

describe('display helpers', () => {
  it('statusLabel replaces underscores', () => {
    expect(statusLabel('pending_approval')).toBe('pending approval');
    expect(statusLabel('active')).toBe('active');
  });
  it('formatAppliedDate uses en-US short month', () => {
    expect(formatAppliedDate('2026-06-17T12:00:00Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026$/);
  });
});
