/**
 * Unit + parity tests for the Partner Dashboard pure logic (D-211 Phase 12).
 *
 * Pins against partner-dashboard.html @ main behavior:
 *   - gating decision table (settled-gate; referral_agents-table-first;
 *     /login + /partner-re.html bounces)
 *   - the D-172 W-9 card state machine (hidden/verified/submitted/action-required)
 *   - the D-180 payout-approval badge map + newest-wins reducer
 *   - loadStats() math + recruit-earnings aggregation (NOT count×$50)
 *   - referral status label/class maps; identity/link builders
 *   - formatRelativeDate
 *   - VERBATIM Tier-3 W-9 / IRS / payout legal copy (byte-for-byte)
 *   - the submit-partner-w9 EF contract (field name, URL, EF name)
 *
 * No network / supabase calls — every helper is side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import type { PartnerRecord } from '@/lib/partner-record';
import {
  type PartnerReferral,
  type RecruitRecord,
  type PayoutApproval,
  partnerGateDecision,
  agentDisplayName,
  partnerBadgeLabel,
  referralLinkFor,
  recruitLinkState,
  w9CardState,
  referralStatusLabel,
  referralStatusClass,
  referralClientName,
  fmtMoneyCell,
  payoutBadge,
  referralIdsForPayout,
  payoutStatusByReferral,
  computeStats,
  fmtMoneyWhole,
  referralsSubtext,
  activeSubtext,
  completedSubtext,
  partnersRecruitedSubtext,
  recruitTypeLabel,
  recruitName,
  aggregateRecruitEarnings,
  recruitStats,
  formatRelativeDate,
  w9SubmitUrl,
} from '../utils';
import {
  W9_COPY,
  PAYOUT_COPY,
  IRS_W9_URL,
  W9_EF_NAME,
  W9_EF_FORM_FIELD,
  LOGIN_ROUTE,
  PARTNER_SIGNUP_REDIRECT,
  RECRUIT_LINK_PENDING,
  REFERRAL_FEE_DISCLAIMER,
} from '../copy';

function mkPartner(over: Partial<PartnerRecord> = {}): PartnerRecord {
  return { id: 'p-1', ...over };
}
function mkRef(over: Partial<PartnerReferral> = {}): PartnerReferral {
  return { id: over.id ?? 'r-1', ...over };
}

// ============================================================
// Gating parity (the heart of the brief)
// ============================================================
describe('partnerGateDecision — gating parity (settled-gate, table-first)', () => {
  it('not settled → loading (never act on the transient blank screen)', () => {
    expect(partnerGateDecision({ settled: false, hasUser: false, resolution: 'pending' })).toBe('loading');
    expect(partnerGateDecision({ settled: false, hasUser: true, resolution: 'ok' })).toBe('loading');
  });
  it('settled & no user → bounce to React /login', () => {
    expect(partnerGateDecision({ settled: true, hasUser: false, resolution: 'pending' })).toBe('bounce-login');
  });
  it('settled & user, still resolving → loading', () => {
    expect(partnerGateDecision({ settled: true, hasUser: true, resolution: 'pending' })).toBe('loading');
  });
  it('settled & user, no referral_agents record → bounce to STATIC /partner-re.html', () => {
    expect(partnerGateDecision({ settled: true, hasUser: true, resolution: 'no-record' })).toBe('bounce-signup');
  });
  it('settled & user, record ok → ready', () => {
    expect(partnerGateDecision({ settled: true, hasUser: true, resolution: 'ok' })).toBe('ready');
  });
  it('bounce targets are the static chooser + the React login route', () => {
    expect(PARTNER_SIGNUP_REDIRECT).toBe('/partner-re.html');
    expect(LOGIN_ROUTE).toBe('/login');
  });
});

// ============================================================
// Identity + links (updateUI)
// ============================================================
describe('identity + links', () => {
  it('agentDisplayName joins first+last, drops falsy, else "Agent"', () => {
    expect(agentDisplayName({ first_name: 'Sarah', last_name: 'Johnson' })).toBe('Sarah Johnson');
    expect(agentDisplayName({ first_name: 'Sarah', last_name: null })).toBe('Sarah');
    expect(agentDisplayName({ first_name: null, last_name: null })).toBe('Agent');
  });

  it('partnerBadgeLabel maps agent_type; customer→Partner; unknown→Partner', () => {
    expect(partnerBadgeLabel('re_agent')).toBe('RE Agent');
    expect(partnerBadgeLabel('insurance_agent')).toBe('Insurance Agent');
    expect(partnerBadgeLabel('home_inspector')).toBe('Home Inspector');
    expect(partnerBadgeLabel('customer')).toBe('Partner');
    expect(partnerBadgeLabel('weird')).toBe('Partner');
    expect(partnerBadgeLabel(null)).toBe('Partner');
  });

  it('referralLinkFor prefers unique_code, falls back to id', () => {
    expect(referralLinkFor({ unique_code: 'agent123', id: 'p-1' })).toBe('https://otterquote.com/ref.html?code=agent123');
    expect(referralLinkFor({ unique_code: null, id: 'p-1' })).toBe('https://otterquote.com/ref.html?code=p-1');
  });

  it('recruitLinkState: enabled link when recruit_code present, else pending message', () => {
    expect(recruitLinkState({ recruit_code: 'rc9' }, RECRUIT_LINK_PENDING)).toEqual({
      enabled: true,
      text: 'otterquote.com/recruit.html?code=rc9',
    });
    expect(recruitLinkState({ recruit_code: null }, RECRUIT_LINK_PENDING)).toEqual({
      enabled: false,
      text: RECRUIT_LINK_PENDING,
    });
  });
});

// ============================================================
// W-9 card state machine (D-172) — renderW9Card parity
// ============================================================
describe('w9CardState — D-172 state machine', () => {
  it('hidden when not blocked and nothing submitted', () => {
    expect(w9CardState({ payments_blocked: false, w9_submitted_at: null, w9_verified_at: null })).toBe('hidden');
    expect(w9CardState({ payments_blocked: null, w9_submitted_at: null, w9_verified_at: null })).toBe('hidden');
  });
  it('verified wins when w9_verified_at is set', () => {
    expect(w9CardState({ payments_blocked: true, w9_submitted_at: 'x', w9_verified_at: 'y' })).toBe('verified');
    expect(w9CardState({ payments_blocked: false, w9_submitted_at: 'x', w9_verified_at: 'y' })).toBe('verified');
  });
  it('submitted (under review) when submitted but not verified', () => {
    expect(w9CardState({ payments_blocked: false, w9_submitted_at: 'x', w9_verified_at: null })).toBe('submitted');
  });
  it('action-required when blocked with no submission', () => {
    expect(w9CardState({ payments_blocked: true, w9_submitted_at: null, w9_verified_at: null })).toBe('action-required');
  });
});

// ============================================================
// Referral table (populateReferralsTable)
// ============================================================
describe('referral table cells', () => {
  it('status labels match the static v7 map; unknown → raw', () => {
    expect(referralStatusLabel('clicked')).toBe('Clicked');
    expect(referralStatusLabel('registered')).toBe('Registered');
    expect(referralStatusLabel('claim_submitted')).toBe('Submitted');
    expect(referralStatusLabel('bid_received')).toBe('Bid Received');
    expect(referralStatusLabel('contract_signed')).toBe('Contract Signed');
    expect(referralStatusLabel('job_completed')).toBe('Completed');
    expect(referralStatusLabel('commission_paid')).toBe('Paid');
    expect(referralStatusLabel('mystery')).toBe('mystery');
  });
  it('status classes match the static map; unknown → status-clicked', () => {
    expect(referralStatusClass('registered')).toBe('status-registered');
    expect(referralStatusClass('bid_received')).toBe('status-in-progress');
    expect(referralStatusClass('contract_signed')).toBe('status-in-progress');
    expect(referralStatusClass('commission_paid')).toBe('status-paid');
    expect(referralStatusClass('mystery')).toBe('status-clicked');
  });
  it('client name: homeowner_name || homeowner_email || "Visitor"', () => {
    expect(referralClientName({ homeowner_name: 'John', homeowner_email: 'j@x.com' })).toBe('John');
    expect(referralClientName({ homeowner_name: null, homeowner_email: 'j@x.com' })).toBe('j@x.com');
    expect(referralClientName({ homeowner_name: null, homeowner_email: null })).toBe('Visitor');
  });
  it('money cell: falsy → "—" else $-formatted', () => {
    expect(fmtMoneyCell(null)).toBe('—');
    expect(fmtMoneyCell(0)).toBe('—');
    expect(fmtMoneyCell(15000)).toBe(`$${Number(15000).toLocaleString()}`);
  });
});

// ============================================================
// D-180 payout badge map + reducer
// ============================================================
describe('payout badge (D-180)', () => {
  it('pending_approval → amber pending badge', () => {
    expect(payoutBadge('pending_approval', PAYOUT_COPY)).toEqual({
      className: 'payout-badge-pending',
      label: PAYOUT_COPY.pending.label,
      title: PAYOUT_COPY.pending.title,
    });
  });
  it('rejected → red under-review badge', () => {
    expect(payoutBadge('rejected', PAYOUT_COPY)).toEqual({
      className: 'payout-badge-rejected',
      label: PAYOUT_COPY.rejected.label,
      title: PAYOUT_COPY.rejected.title,
    });
  });
  it('approved / auto_approved / pre_approved / null → no badge', () => {
    expect(payoutBadge('approved', PAYOUT_COPY)).toBeNull();
    expect(payoutBadge('auto_approved', PAYOUT_COPY)).toBeNull();
    expect(payoutBadge('pre_approved', PAYOUT_COPY)).toBeNull();
    expect(payoutBadge(null, PAYOUT_COPY)).toBeNull();
  });
  it('referralIdsForPayout: only commission_amount > 0', () => {
    const refs = [
      mkRef({ id: 'a', commission_amount: 300 }),
      mkRef({ id: 'b', commission_amount: 0 }),
      mkRef({ id: 'c', commission_amount: null }),
      mkRef({ id: 'd', commission_amount: 50 }),
    ];
    expect(referralIdsForPayout(refs)).toEqual(['a', 'd']);
  });
  it('payoutStatusByReferral: newest-wins (first seen, list is DESC ordered)', () => {
    const approvals: PayoutApproval[] = [
      { referral_id: 'a', status: 'rejected' }, // newest for a
      { referral_id: 'a', status: 'pending_approval' }, // older — ignored
      { referral_id: 'b', status: 'pending_approval' },
    ];
    expect(payoutStatusByReferral(approvals)).toEqual({ a: 'rejected', b: 'pending_approval' });
  });
});

// ============================================================
// Stats (loadStats)
// ============================================================
describe('computeStats — loadStats parity', () => {
  const referrals: PartnerReferral[] = [
    mkRef({ status: 'registered' }),
    mkRef({ status: 'claim_submitted' }),
    mkRef({ status: 'bid_received' }),
    mkRef({ status: 'contract_signed' }),
    mkRef({ status: 'job_completed' }),
    mkRef({ status: 'commission_paid', commission_amount: 300 }),
    mkRef({ status: 'commission_paid', commission_amount: 170 }),
    mkRef({ status: 'clicked' }),
  ];

  it('counts active/completed and uses agent totals when present', () => {
    const s = computeStats({ total_referrals: 42, total_commission_earned: 999 }, referrals);
    expect(s).toEqual({ total: 42, active: 4, completed: 3, earned: 999 });
  });
  it('falls back to referrals.length and summed paid commissions', () => {
    const s = computeStats({ total_referrals: 0, total_commission_earned: 0 }, referrals);
    expect(s.total).toBe(8);
    expect(s.active).toBe(4);
    expect(s.completed).toBe(3);
    expect(s.earned).toBe(470); // 300 + 170
  });
  it('fmtMoneyWhole formats with no decimals', () => {
    expect(fmtMoneyWhole(470)).toBe(`$${Number(470).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
  });
  it('subtext pluralization', () => {
    expect(referralsSubtext(1)).toBe('1 referral');
    expect(referralsSubtext(2)).toBe('2 referrals');
    expect(activeSubtext(1)).toBe('1 active');
    expect(completedSubtext(1)).toBe('1 job');
    expect(completedSubtext(3)).toBe('3 jobs');
    expect(partnersRecruitedSubtext(1)).toBe('1 partner');
    expect(partnersRecruitedSubtext(5)).toBe('5 partners');
  });
});

// ============================================================
// Recruits (loadRecruits / updateRecruitStats)
// ============================================================
describe('recruit aggregation', () => {
  it('recruitName: name || email || "Partner"; type map (customer→Customer)', () => {
    expect(recruitName({ first_name: 'Al', last_name: 'Bo', email: 'a@x.com' })).toBe('Al Bo');
    expect(recruitName({ first_name: null, last_name: null, email: 'a@x.com' })).toBe('a@x.com');
    expect(recruitName({ first_name: null, last_name: null, email: null })).toBe('Partner');
    expect(recruitTypeLabel('customer')).toBe('Customer');
    expect(recruitTypeLabel('re_agent')).toBe('RE Agent');
    expect(recruitTypeLabel('unknown')).toBe('Partner');
  });

  it('aggregateRecruitEarnings sums recruit_commission_amount per agent (NOT count×$50)', () => {
    const paidRefs: PartnerReferral[] = [
      mkRef({ referral_agent_id: 'rec-1', recruit_commission_amount: 50 }),
      mkRef({ referral_agent_id: 'rec-1', recruit_commission_amount: 50 }),
      mkRef({ referral_agent_id: 'rec-2', recruit_commission_amount: 75 }),
    ];
    expect(aggregateRecruitEarnings(paidRefs)).toEqual({ 'rec-1': 100, 'rec-2': 75 });
  });

  it('recruitStats: count from rows, earnings from partner.recruit_earnings (authoritative)', () => {
    const recruits: RecruitRecord[] = [mkPartner({ id: 'rec-1' }), mkPartner({ id: 'rec-2' })];
    expect(recruitStats(mkPartner({ recruit_earnings: 250 }), recruits)).toEqual({ count: 2, earnings: 250 });
    expect(recruitStats(mkPartner({ recruit_earnings: null }), recruits).earnings).toBe(0);
    expect(recruitStats(null, []).earnings).toBe(0);
  });
});

// ============================================================
// formatRelativeDate
// ============================================================
describe('formatRelativeDate', () => {
  const NOW = new Date('2026-06-17T12:00:00Z').getTime();
  const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

  it('empty/invalid → "—"', () => {
    expect(formatRelativeDate(null, NOW)).toBe('—');
    expect(formatRelativeDate('not-a-date', NOW)).toBe('—');
  });
  it('today / yesterday / days / weeks / months', () => {
    expect(formatRelativeDate(daysAgo(0), NOW)).toBe('Today');
    expect(formatRelativeDate(daysAgo(1), NOW)).toBe('Yesterday');
    expect(formatRelativeDate(daysAgo(3), NOW)).toBe('3 days ago');
    expect(formatRelativeDate(daysAgo(8), NOW)).toBe('1 week ago');
    expect(formatRelativeDate(daysAgo(14), NOW)).toBe('2 weeks ago');
    expect(formatRelativeDate(daysAgo(40), NOW)).toBe('1 month ago');
  });
  it('future date → absolute date', () => {
    const future = new Date(NOW + 5 * 86400000).toISOString();
    expect(formatRelativeDate(future, NOW)).toBe(
      new Date(future).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    );
  });
});

// ============================================================
// submit-partner-w9 EF contract — UNCHANGED (Tier-3)
// ============================================================
describe('submit-partner-w9 EF contract (UNCHANGED)', () => {
  it('EF name + form field byte-for-byte', () => {
    expect(W9_EF_NAME).toBe('submit-partner-w9');
    expect(W9_EF_FORM_FIELD).toBe('w9_file');
  });
  it('URL is ${SUPABASE_URL}/functions/v1/submit-partner-w9', () => {
    expect(w9SubmitUrl('https://abc.supabase.co')).toBe('https://abc.supabase.co/functions/v1/submit-partner-w9');
  });
});

// ============================================================
// VERBATIM Tier-3 legal / IRS / payout copy (byte-for-byte)
// ============================================================
describe('verbatim Tier-3 W-9 / IRS / payout copy', () => {
  it('D-266 referral-fee legality disclaimer (byte-for-byte, Dustin-dictated)', () => {
    expect(REFERRAL_FEE_DISCLAIMER).toBe(
      'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.',
    );
  });
  it('the IRS $600 W-9 disclosure (action-required body)', () => {
    expect(W9_COPY.actionRequired.body).toBe(
      'Commission payments are held until we have a completed IRS Form W-9 on file. This is required by the IRS for any partner receiving $600 or more in referral payments per year.',
    );
  });
  it('action-required title + buttons + IRS link', () => {
    expect(W9_COPY.actionRequired.title).toBe('Action Required: Submit Your W-9');
    expect(W9_COPY.actionRequired.uploadBtn).toBe('Upload W-9 PDF');
    expect(W9_COPY.actionRequired.irsLinkText).toBe('Download blank W-9 from IRS →');
    expect(IRS_W9_URL).toBe('https://www.irs.gov/pub/irs-pdf/fw9.pdf');
  });
  it('verified state copy', () => {
    expect(W9_COPY.verified.title).toBe('W-9 Verified');
    expect(W9_COPY.verified.bodyPrefix).toBe('Verified on ');
    expect(W9_COPY.verified.bodySuffix).toBe('. Commission payments are enabled.');
  });
  it('submitted (under review) state copy', () => {
    expect(W9_COPY.submitted.title).toBe('W-9 Received — Under Review');
    expect(W9_COPY.submitted.bodyPrefix).toBe('Submitted on ');
    expect(W9_COPY.submitted.bodySuffix).toBe('. Our team will review your W-9 and enable payments promptly.');
    expect(W9_COPY.submitted.replaceLink).toBe('Need to replace your W-9? Upload a new one');
  });
  it('D-180 payout badge copy (partner-facing)', () => {
    expect(PAYOUT_COPY.pending.label).toBe('Pending — typically 5 days');
    expect(PAYOUT_COPY.pending.title).toBe('Your commission is pending approval — typically within 5 business days');
    expect(PAYOUT_COPY.rejected.label).toBe('Under Review — our team will be in touch');
    expect(PAYOUT_COPY.rejected.title).toBe('Your commission is under review — our team will be in touch');
  });
});
