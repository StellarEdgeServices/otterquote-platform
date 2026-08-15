/**
 * Unit + parity tests for the Refer-a-Friend pure logic (D-211 Phase 13,
 * re-ported #576).
 *
 * Pins refer-a-friend.html @ main current behavior: the two-step referrals
 * lookup (referral_agents.id -> referrals.referral_agent_id, #567), the full
 * 7-value status enum + paid/pending commission split (D-139), and the
 * get_or_create_customer_referral_code() RPC shape (v100/#624) — plus the
 * W-9 banner gate, the homeowner launch gate, the share-message builders, and
 * the VERBATIM Tier-3 tax/legal copy (byte-for-byte).
 *
 * No network / supabase calls — every helper is side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import {
  type CustomerReferral,
  PUBLIC_SITE_URL,
  REFERRAL_COMMISSION_USD,
  COMING_SOON_REDIRECT,
  referralUrl,
  referralFriendName,
  referralDate,
  referralStatusLabel,
  referralStatusClass,
  referralCommissionCell,
  referralRowCells,
  summarizeReferrals,
  referralSummaryLine,
  shouldShowW9Banner,
  isHomeownerLaunchEnabled,
  FACEBOOK_SHARE_MESSAGE,
  smsShareMessage,
  nextdoorShareMessage,
  EMAIL_SHARE_SUBJECT,
  emailShareBody,
  emailSignatureBadgeHtml,
  facebookShareUrl,
} from '../utils';
import {
  HERO,
  HOW_IT_WORKS,
  FAQ,
  TAX_NOTICE,
  COMMISSION_APPROVAL_DISCLOSURE,
  W9_BANNER,
  REFERRALS,
  LOGIN_ROUTE,
  W9_UPLOAD_LINK,
} from '../copy';

const mkRef = (over: Partial<CustomerReferral> = {}): CustomerReferral => ({ id: over.id ?? 'r-1', ...over });

// ============================================================
// Referral link + code
// ============================================================
describe('referral link + code', () => {
  it('referralUrl is `${SITE_URL}/ref/${code}` (path style — NOT ref.html?code=)', () => {
    expect(referralUrl('ABC123')).toBe('https://otterquote.com/ref/ABC123');
    expect(referralUrl('ABC123', 'https://staging.otterquote.com')).toBe('https://staging.otterquote.com/ref/ABC123');
    expect(PUBLIC_SITE_URL).toBe('https://otterquote.com');
  });
});

// ============================================================
// Referrals table — full 7-status enum + all four header columns
// ============================================================
describe('referral table cells (four columns, header order, #576)', () => {
  it('referralFriendName: homeowner_name || homeowner_email || positional fallback', () => {
    expect(referralFriendName({ homeowner_name: 'Jane Doe', homeowner_email: 'jane@x.com' }, 0)).toBe('Jane Doe');
    expect(referralFriendName({ homeowner_name: null, homeowner_email: 'jane@x.com' }, 0)).toBe('jane@x.com');
    expect(referralFriendName({ homeowner_name: null, homeowner_email: null }, 2)).toBe('Referral #3');
  });
  it('referralDate: en-US short date; null → "—"', () => {
    expect(referralDate(null)).toBe('—');
    expect(referralDate('2026-03-04T00:00:00Z')).toBe(
      new Date('2026-03-04T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    );
  });
  it('referralStatusLabel covers all 7 statuses; unrecognized/empty → "Pending"', () => {
    expect(referralStatusLabel('clicked')).toBe('Clicked');
    expect(referralStatusLabel('registered')).toBe('Signed Up');
    expect(referralStatusLabel('claim_submitted')).toBe('Project Submitted');
    expect(referralStatusLabel('bid_received')).toBe('Bids In');
    expect(referralStatusLabel('contract_signed')).toBe('Contract Signed');
    expect(referralStatusLabel('job_completed')).toBe('Job Completed');
    expect(referralStatusLabel('commission_paid')).toBe('Commission Paid');
    expect(referralStatusLabel(null)).toBe('Pending');
    expect(referralStatusLabel('')).toBe('Pending');
    expect(referralStatusLabel('some_unknown_value')).toBe('Pending');
  });
  it('referralStatusClass covers all 7 statuses; unrecognized/empty → status-clicked', () => {
    expect(referralStatusClass('clicked')).toBe('status-clicked');
    expect(referralStatusClass('registered')).toBe('status-registered');
    expect(referralStatusClass('claim_submitted')).toBe('status-submitted');
    expect(referralStatusClass('bid_received')).toBe('status-in-progress');
    expect(referralStatusClass('contract_signed')).toBe('status-in-progress');
    expect(referralStatusClass('job_completed')).toBe('status-completed');
    expect(referralStatusClass('commission_paid')).toBe('status-paid');
    expect(referralStatusClass(null)).toBe('status-clicked');
  });
  it('referralCommissionCell: job_completed or commission_paid → $200, else "—"', () => {
    expect(referralCommissionCell('job_completed')).toBe('$200');
    expect(referralCommissionCell('commission_paid')).toBe('$200');
    expect(referralCommissionCell('bid_received')).toBe('—');
    expect(referralCommissionCell(null)).toBe('—');
  });
  it('referralRowCells yields ALL FOUR header columns in order', () => {
    const cells = referralRowCells(
      mkRef({ homeowner_name: 'Jane Doe', created_at: '2026-03-04T00:00:00Z', status: 'commission_paid' }),
      0,
    );
    expect(cells.friend).toBe('Jane Doe');
    expect(cells.date).toBe(referralDate('2026-03-04T00:00:00Z'));
    expect(cells.statusLabel).toBe('Commission Paid');
    expect(cells.statusClass).toBe('status-paid');
    expect(cells.commission).toBe('$200');
  });
});

// ============================================================
// Summary — D-139 paid/pending split (#567)
// ============================================================
describe('summarizeReferrals — paid/pending split', () => {
  const refs: CustomerReferral[] = [
    mkRef({ status: 'commission_paid' }),
    mkRef({ status: 'commission_paid' }),
    mkRef({ status: 'job_completed' }),
    mkRef({ status: 'bid_received' }),
    mkRef({ status: 'clicked' }),
  ];
  it('earned counts paid only; pending counts job_completed (not yet paid) separately', () => {
    const s = summarizeReferrals(refs);
    expect(s.total).toBe(5);
    expect(s.completed).toBe(3); // 2 paid + 1 completedUnpaid
    expect(s.earned).toBe(400); // 2 × $200 paid
    expect(s.pending).toBe(200); // 1 × $200 job_completed, not yet paid
    expect(REFERRAL_COMMISSION_USD).toBe(200);
  });
  it('referralSummaryLine format is byte-for-byte the static (· separators, earned = paid only)', () => {
    expect(referralSummaryLine({ total: 5, completed: 3, earned: 400, pending: 200 })).toBe('5 referrals · 3 completed · $400 earned');
    expect(referralSummaryLine({ total: 1, completed: 0, earned: 0, pending: 0 })).toBe('1 referral · 0 completed · $0 earned');
  });
});

// ============================================================
// W-9 banner gate (renderW9Banner) + homeowner launch gate
// ============================================================
describe('gates', () => {
  it('shouldShowW9Banner: blocked && notified && not-submitted', () => {
    expect(shouldShowW9Banner({ payments_blocked: true, w9_notification_sent_at: '2026-01-01', w9_submitted_at: null })).toBe(true);
    expect(shouldShowW9Banner({ payments_blocked: false, w9_notification_sent_at: '2026-01-01', w9_submitted_at: null })).toBe(false);
    expect(shouldShowW9Banner({ payments_blocked: true, w9_notification_sent_at: null, w9_submitted_at: null })).toBe(false);
    expect(shouldShowW9Banner({ payments_blocked: true, w9_notification_sent_at: '2026-01-01', w9_submitted_at: '2026-02-01' })).toBe(false);
    expect(shouldShowW9Banner(null)).toBe(false);
  });
  it('isHomeownerLaunchEnabled: only the literal "false" re-gates', () => {
    expect(isHomeownerLaunchEnabled(undefined)).toBe(true);
    expect(isHomeownerLaunchEnabled('true')).toBe(true);
    expect(isHomeownerLaunchEnabled('1')).toBe(true);
    expect(isHomeownerLaunchEnabled('false')).toBe(false);
    expect(COMING_SOON_REDIRECT).toBe('/coming-soon.html?from=refer-a-friend&persona=homeowner');
  });
});

// ============================================================
// Share-message builders (verbatim marketing copy)
// ============================================================
describe('share builders', () => {
  const url = 'https://otterquote.com/ref/ABC123';
  it('Facebook fixed message + share URL', () => {
    expect(FACEBOOK_SHARE_MESSAGE).toBe(
      'I just got my roof replaced through Otter Quotes — multiple contractors competed for the job and I got a great deal. Check it out if you need any exterior work done!',
    );
    expect(facebookShareUrl(url)).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(FACEBOOK_SHARE_MESSAGE)}`,
    );
  });
  it('SMS message interpolates the URL', () => {
    expect(smsShareMessage(url)).toBe(
      `Hey! I just got my roof done through Otter Quotes — they had multiple contractors compete for the job. If you need any exterior work done, check them out: ${url}`,
    );
  });
  it('Nextdoor message interpolates the URL', () => {
    expect(nextdoorShareMessage(url)).toContain('Four contractors competed for the job');
    expect(nextdoorShareMessage(url).endsWith(url)).toBe(true);
  });
  it('Email subject + body', () => {
    expect(EMAIL_SHARE_SUBJECT).toBe('Check out Otter Quotes — best way to get contractor quotes');
    expect(emailShareBody(url)).toContain('I recently used Otter Quotes to get my roof replaced');
    expect(emailShareBody(url)).toContain(url);
    expect(emailShareBody(url).endsWith('Best regards')).toBe(true);
  });
  it('Email-signature badge HTML interpolates link + logo', () => {
    const html = emailSignatureBadgeHtml(url);
    expect(html).toContain(`<a href="${url}" target="_blank"`);
    expect(html).toContain(`<img src="https://otterquote.com/img/otter-logo.svg"`);
    expect(html).toContain('<span>I trust Otter Quotes</span>');
  });
});

// ============================================================
// VERBATIM Tier-3 tax/legal copy (byte-for-byte) + $200 representations
// ============================================================
describe('verbatim Tier-3 tax/legal copy', () => {
  it('1099-MISC Tax Reporting Notice (disclosure 1099-misc-v1-2026-04)', () => {
    expect(TAX_NOTICE.version).toBe('1099-misc-v1-2026-04');
    expect(TAX_NOTICE.label).toBe('Tax Reporting Notice');
    expect(TAX_NOTICE.body).toBe(
      'Your $200 referral bonus is taxable income. If you receive $600 or more in referral bonuses from Otter Quotes in a calendar year, we are required by federal law to file a Form 1099-MISC with the IRS reporting those payments, and to provide you a copy no later than January 31 of the following year. You are responsible for all applicable federal, state, and local taxes on referral income. Otter Quotes does not withhold taxes from bonus payments. We recommend consulting a qualified tax professional if you have questions about your tax obligations.',
    );
  });
  it('FAQ tax answer (1099-MISC / $600 / Jan 31)', () => {
    expect(FAQ[3].q).toBe('Will I receive a tax form for my referral bonuses?');
    expect(FAQ[3].a).toBe(
      'Yes — referral bonuses are taxable income. If you receive $600 or more in bonuses from Otter Quotes in a calendar year, we are required to report those payments to the IRS and will issue you a Form 1099-MISC. You will receive a copy no later than January 31 of the following year. You are responsible for all applicable federal, state, and local taxes on referral income. We recommend consulting a tax professional regarding your specific situation.',
    );
  });
  it('D-180 commission-approval disclosure', () => {
    expect(COMMISSION_APPROVAL_DISCLOSURE).toBe(
      "Commission payments are subject to Otter Quotes' approval process and are paid after the qualifying job is complete and the payout has been approved.",
    );
  });
  it('D-172 W-9 banner copy', () => {
    expect(W9_BANNER.title).toBe('W-9 Required Before Payment');
    expect(W9_BANNER.body).toBe("Your referral generated a commission, but it's on hold until we receive your W-9.");
    expect(W9_BANNER.link).toBe('Upload your W-9 in your partner dashboard →');
    expect(W9_UPLOAD_LINK).toBe('/partner-dashboard.html#w9Upload');
  });
  it('the $200 / $10,000 representations are intact (hero, How-It-Works, FAQ)', () => {
    expect(HERO.heading).toBe('Love Your Project Results? Share the Love — and Earn $200');
    expect(HERO.subtitle).toContain('completes a project of $10,000 or more');
    expect(HERO.subtitle).toContain('you earn $200');
    expect(HOW_IT_WORKS[2].title).toBe('You Earn $200');
    expect(HOW_IT_WORKS[2].text).toBe('When their job completes ($10K or more), you earn $200 in commission.');
    expect(FAQ[2].a).toContain("You won't receive a cash commission for jobs under $10K");
  });
  it('table headers match the static (four columns)', () => {
    expect(REFERRALS.thFriend).toBe("Friend's Name");
    expect(REFERRALS.thDate).toBe('Date Referred');
    expect(REFERRALS.thStatus).toBe('Status');
    expect(REFERRALS.thCommission).toBe('Commission');
    expect(LOGIN_ROUTE).toBe('/login');
  });
});
