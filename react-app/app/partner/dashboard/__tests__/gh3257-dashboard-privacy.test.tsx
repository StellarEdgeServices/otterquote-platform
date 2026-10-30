/**
 * gh-3257 (Dustin's ruling "Match the policy (Recommended)"; privacy.html 4.7): the partner and refer dashboards
 *   - never render the job's dollar value (get_my_referrals() returns it as NULL for every row after
 *     gh3257_get_my_referrals_privacy, and no page has a column for it);
 *   - render a row whose homeowner declined updates (status NULL from the RPC) as "Referral #N — updates declined"
 *     with no progress status;
 *   - show the referrer's own fee only once earned (commission_amount set), opted out or not.
 * "updates declined" is the only new string.
 *
 * NEGATIVE CONTROLS: every "declined" fixture below carries a real-looking status and job value in the fields the old
 * code read, so the pre-change code fails these tests (verified on PR #3257's head by running this file against the
 * #3255 head e042a4a8: the React render, the static-page harnesses and the source guards all fail). The opted-in
 * control rows must still render their status badge, which proves the harness can see a status when one is shown.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import {
  referralRowName,
  referralShowsStatus,
  referralFeeCell,
  computeStats,
  type PartnerReferral,
} from '../utils';
import { referralRowCells, summarizeReferrals } from '../../../refer/utils';
import {
  REFERRAL_UPDATES_DECLINED,
  referralUpdatesDeclined,
  declinedReferralLabel,
  referralFeeEarned,
} from '@/lib/referral-privacy';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

// RPC rows as get_my_referrals() returns them after gh3257 (newest first). job_value is NULL for every row; the
// LEAK_* values are what the pre-change RPC returned and must never reach the DOM.
const LEAK_JOB_VALUE = 18765;
const ROWS = [
  // declined, fee earned and paid
  { id: 'r1', referral_agent_id: 'p-1', created_at: '2026-10-05T00:00:00Z', status: null, display_name: null, job_value: null, commission_amount: 201, commission_paid_at: '2026-10-06T00:00:00Z' },
  // opted-in control
  { id: 'r2', referral_agent_id: 'p-1', created_at: '2026-10-04T00:00:00Z', status: 'contract_signed', display_name: 'Bea K.', job_value: null, commission_amount: null, commission_paid_at: null },
  // declined, fee not earned
  { id: 'r3', referral_agent_id: 'p-1', created_at: '2026-10-03T00:00:00Z', status: null, display_name: null, job_value: null, commission_amount: null, commission_paid_at: null },
];
// The same rows as the pre-change RPC returned them (status + job_value present). Used where the test must show that
// nothing on the page reads those fields any more.
const PRE_CHANGE_ROWS = ROWS.map((r, i) => ({
  ...r,
  status: r.status ?? (i === 0 ? 'commission_paid' : 'bid_received'),
  job_value: LEAK_JOB_VALUE,
}));

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: { id: 'u-1', email: 'p@example.test' }, settled: true }),
}));
vi.mock('@/lib/partner-record', () => ({
  resolvePartnerRecord: async () => ({
    kind: 'ok',
    partner: { id: 'p-1', first_name: 'Pat', payments_blocked: false, w9_submitted_at: null, w9_verified_at: null },
  }),
  fetchPartnerByUserId: async () => null,
}));
vi.mock('@/lib/supabase', () => {
  const from = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'not', 'order']) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(res, rej);
    return chain;
  };
  return {
    supabase: {
      from,
      rpc: async () => ({ data: h.rows, error: null }),
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
  };
});

import PartnerDashboardPage from '../page';

async function renderTable(rows: unknown[]) {
  h.rows = rows;
  const view = render(<PartnerDashboardPage />);
  await waitFor(() => expect(view.container.querySelector('table.referrals-table tbody tr')).toBeTruthy());
  const table = view.container.querySelector('table.referrals-table') as HTMLTableElement;
  return { view, table };
}

describe('approved copy', () => {
  it('the only new string is "updates declined"', () => {
    expect(REFERRAL_UPDATES_DECLINED).toBe('updates declined');
    expect(declinedReferralLabel(0)).toBe('Referral #1 — updates declined');
  });
});

describe('pure helpers', () => {
  it('a NULL status from the RPC means updates declined; any status does not', () => {
    expect(referralUpdatesDeclined({ status: null })).toBe(true);
    expect(referralUpdatesDeclined({})).toBe(true);
    expect(referralUpdatesDeclined({ status: 'clicked' })).toBe(false); // negative control
  });
  it('partner row name: declined -> Referral #N — updates declined; opted in -> masked name', () => {
    expect(referralRowName({ status: null, display_name: null }, 2)).toBe('Referral #3 — updates declined');
    expect(referralRowName({ status: 'job_completed', display_name: 'Bea K.' }, 2)).toBe('Bea K.');
    expect(referralRowName({ status: 'clicked', display_name: null }, 0)).toBe('Visitor');
  });
  it('declined rows show no status; opted-in rows do', () => {
    expect(referralShowsStatus({ status: null })).toBe(false);
    expect(referralShowsStatus({ status: 'bid_received' })).toBe(true);
  });
  it('the fee shows only once earned (commission_amount set)', () => {
    expect(referralFeeEarned({ commission_amount: null })).toBe(false);
    expect(referralFeeEarned({ commission_amount: 201 })).toBe(true);
    expect(referralFeeCell({ commission_amount: null })).toBe('—');
    expect(referralFeeCell({ commission_amount: 201 })).toBe('$201');
  });
  it('declined rows count in neither the active nor the completed stat', () => {
    const s = computeStats({ total_referrals: 0, total_commission_earned: 0 }, ROWS as PartnerReferral[]);
    expect(s).toMatchObject({ total: 3, active: 1, completed: 0 });
  });
});

describe('React partner dashboard (real page, RPC mocked)', () => {
  it('has no Job Value column and renders no job value', async () => {
    const { table } = await renderTable(PRE_CHANGE_ROWS.map((r) => ({ ...r, status: r.status })));
    const headers = Array.from(table.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Client Name', 'Date Referred', 'Status', 'Referral Fee']);
    // even when an (old) RPC still returns a job value, nothing renders it
    expect(table.textContent).not.toContain('18,765');
    expect(table.textContent).not.toContain('18765');
  });

  it('declined rows: "Referral #N — updates declined", no status badge, fee only once earned', async () => {
    const { table } = await renderTable(ROWS);
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    const cells = rows.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent));
    expect(cells[0][0]).toBe('Referral #1 — updates declined');
    expect(cells[0][2]).toBe('—');
    expect(rows[0].querySelector('.status-badge')).toBeNull();
    expect(cells[0][3]).toBe('$201');
    expect(cells[2][0]).toBe('Referral #3 — updates declined');
    expect(rows[2].querySelector('.status-badge')).toBeNull();
    expect(cells[2][3]).toBe('—');
    // NEGATIVE CONTROL: the opted-in row keeps its name and its status badge
    expect(cells[1][0]).toBe('Bea K.');
    expect(within(rows[1] as HTMLElement).getByText('Contract Signed').className).toContain('status-badge');
  });

  it('with the pre-change RPC output, opted-in rows still show their status (the harness sees statuses)', async () => {
    const { table } = await renderTable(PRE_CHANGE_ROWS);
    expect(table.querySelectorAll('tbody .status-badge')).toHaveLength(3);
    expect(screen.queryByText(/updates declined/)).toBeNull();
  });
});

describe('React refer page cells', () => {
  it('declined rows: label, no status, $200 only once earned; opted-in control unchanged', () => {
    const declinedPaid = referralRowCells({ status: null, display_name: null, commission_amount: 200, commission_paid_at: '2026-10-06T00:00:00Z' }, 0);
    expect(declinedPaid).toMatchObject({ friend: 'Referral #1 — updates declined', showStatus: false, commission: '$200' });
    const declinedNotEarned = referralRowCells({ status: null, display_name: null, commission_amount: null }, 1);
    expect(declinedNotEarned).toMatchObject({ friend: 'Referral #2 — updates declined', showStatus: false, commission: '—' });
    const optedIn = referralRowCells({ status: 'job_completed', display_name: 'Bea K.' }, 2);
    expect(optedIn).toMatchObject({ friend: 'Bea K.', showStatus: true, statusLabel: 'Job Completed', commission: '$200' });
  });
  it('summary counts a declined row from its fee fields, not its status', () => {
    const s = summarizeReferrals([
      { status: null, commission_amount: 200, commission_paid_at: '2026-10-06T00:00:00Z' },
      { status: null, commission_amount: 200, commission_paid_at: null },
      { status: null, commission_amount: null },
      { status: 'commission_paid' },
    ]);
    expect(s).toEqual({ total: 4, completed: 3, earned: 400, pending: 200 });
  });
});

// ── Static pages: run the page's own row/summary functions in a sandbox ──────
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
const escapeHtmlSrc = `function escapeHtml(str){ if(!str) return ''; return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }`;

function staticPartnerTable(rows: unknown[]): { html: string; rows: string[][] } {
  const src = read('partner-dashboard.html');
  const tbody = { innerHTML: '' };
  const sandbox: Record<string, unknown> = {
    allReferrals: rows,
    payoutStatusByReferral: {},
    currentDateFilter: 'all-time',
    isWithinDateRange: () => true,
    document: { getElementById: (id: string) => (id === 'referralsTableBody' ? tbody : { style: {} }) },
  };
  vm.runInNewContext(`${escapeHtmlSrc}\n${extractFunction(src, 'populateReferralsTable')}\npopulateReferralsTable();`, sandbox);
  const doc = new DOMParser().parseFromString(`<table><tbody>${tbody.innerHTML}</tbody></table>`, 'text/html');
  return {
    html: tbody.innerHTML,
    rows: Array.from(doc.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent!.trim())),
  };
}

describe('static partner-dashboard.html', () => {
  const src = read('partner-dashboard.html');
  it('source guard: no job value anywhere (column header, row cell, demo data, direct read)', () => {
    expect(src).not.toContain('job_value');
    expect(src).not.toMatch(/Job Value/i);
  });
  it('source guard: loadStats no longer reads status straight from the referrals table', () => {
    const loadStats = extractFunction(src, 'loadStats');
    expect(loadStats).not.toMatch(/from\(['"]referrals['"]\)/);
    expect(loadStats).toContain('allReferrals');
  });
  it('populateReferralsTable: declined rows, fee once earned, no job value; opted-in control keeps its badge', () => {
    const out = staticPartnerTable(ROWS.map((r) => ({ ...r, job_value: LEAK_JOB_VALUE })));
    expect(out.rows.map((r) => r.length)).toEqual([4, 4, 4]);
    expect(out.rows[0]).toEqual(['Referral #1 — updates declined', expect.any(String), '—', '$201']);
    expect(out.rows[2]).toEqual(['Referral #3 — updates declined', expect.any(String), '—', '—']);
    expect(out.rows[1][0]).toBe('Bea K.');
    expect(out.rows[1][2]).toBe('Contract Signed');
    expect(out.html.match(/status-badge/g)).toHaveLength(1);
    expect(out.html).not.toContain('18,765');
    expect(out.html).not.toContain('18765');
  });
});

function staticReferTable(rows: unknown[]): string[][] {
  const src = read('refer-a-friend.html');
  const tbody = { innerHTML: '' };
  const labelsStart = src.indexOf('const REFERRAL_STATUS_LABELS');
  const classesEnd = src.indexOf('};', src.indexOf('const REFERRAL_STATUS_CLASSES')) + 2;
  const sandbox: Record<string, unknown> = { rows, document: { getElementById: () => tbody } };
  vm.runInNewContext(
    `${src.slice(labelsStart, classesEnd)}\n${escapeHtmlSrc}\n${extractFunction(src, 'populateReferralsTable')}\npopulateReferralsTable(rows);`,
    sandbox,
  );
  const doc = new DOMParser().parseFromString(`<table><tbody>${tbody.innerHTML}</tbody></table>`, 'text/html');
  return Array.from(doc.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent!.trim()));
}

function staticReferSummary(rows: unknown[]): Record<string, string> {
  const src = read('refer-a-friend.html');
  const els: Record<string, { textContent: string }> = {
    'total-earned': { textContent: '' },
    'total-pending': { textContent: '' },
    'referral-summary': { textContent: '' },
  };
  vm.runInNewContext(`${extractFunction(src, 'calculateSummary')}\ncalculateSummary(rows);`, {
    rows,
    document: { getElementById: (id: string) => els[id] ?? null },
  });
  return Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v.textContent]));
}

describe('static refer-a-friend.html', () => {
  it('declined rows: label, no status, $200 only once earned; opted-in control unchanged', () => {
    const out = staticReferTable([
      { status: null, display_name: null, commission_amount: 200, commission_paid_at: '2026-10-06T00:00:00Z', created_at: '2026-10-05T00:00:00Z' },
      { status: 'job_completed', display_name: 'Bea K.', commission_amount: 200, created_at: '2026-10-04T00:00:00Z' },
      { status: null, display_name: null, commission_amount: null, created_at: '2026-10-03T00:00:00Z' },
    ]);
    expect(out[0]).toEqual(['Referral #1 — updates declined', expect.any(String), '—', '$200']);
    expect(out[1]).toEqual(['Bea K.', expect.any(String), 'Job Completed', '$200']);
    expect(out[2]).toEqual(['Referral #3 — updates declined', expect.any(String), '—', '—']);
    expect(out.flat().join(' ')).not.toContain('Pending');
  });
  it('summary counts a declined row from its fee fields', () => {
    expect(
      staticReferSummary([
        { status: null, commission_amount: 200, commission_paid_at: '2026-10-06T00:00:00Z' },
        { status: null, commission_amount: 200, commission_paid_at: null },
        { status: null, commission_amount: null },
        { status: 'commission_paid' },
      ]),
    ).toEqual({ 'total-earned': '$400', 'total-pending': '$200', 'referral-summary': '4 referrals · 3 completed · $400 earned' });
  });
});

describe('React source guards', () => {
  it('no page or helper renders a job value', () => {
    for (const f of ['react-app/app/partner/dashboard/page.tsx', 'react-app/app/partner/dashboard/utils.ts', 'react-app/app/refer/page.tsx', 'react-app/app/refer/utils.ts']) {
      expect(read(f), f).not.toContain('job_value');
      expect(read(f), f).not.toMatch(/Job Value/i);
    }
  });
});
