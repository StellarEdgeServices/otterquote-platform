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

import { describe, it, expect, vi } from 'vitest';
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
  isHomeownerLaunchEnabled,
  PARTNER_AGREEMENT_CURRENT_VERSION,
  hasAcceptedAgreementV4,
  loadReferLink,
  acceptAgreementAndIssueLink,
  REFERRAL_STATUS_LABELS,
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
  AGREEMENT_GATE,
  TAX_NOTICE,
  COMMISSION_APPROVAL_DISCLOSURE,
  REFERRAL_FEE_DISCLAIMER,
  REFERRALS,
  LOGIN_ROUTE,
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
  it('referralFriendName: masked display_name || positional fallback (never an email, gh-3217)', () => {
    expect(referralFriendName({ display_name: 'Jane D.' }, 0)).toBe('Jane D.');
    expect(referralFriendName({ display_name: null, homeowner_email: 'jane@x.com' } as never, 0)).toBe('Referral #1');
    expect(referralFriendName({ display_name: null }, 2)).toBe('Referral #3');
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
    expect(referralStatusLabel('commission_paid')).toBe('Referral Fee Paid');
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
      mkRef({ display_name: 'Jane Doe', created_at: '2026-03-04T00:00:00Z', status: 'commission_paid' }),
      0,
    );
    expect(cells.friend).toBe('Jane Doe');
    expect(cells.date).toBe(referralDate('2026-03-04T00:00:00Z'));
    expect(cells.statusLabel).toBe('Referral Fee Paid');
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
// homeowner launch gate (the D-172 W-9 banner gate was removed under D-319)
// ============================================================
describe('gates', () => {
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
  it('Tax Reporting Notice keeps taxes-are-yours + no-withholding, drops the 1099 filing promise (D-319, ruling 5973838853)', () => {
    expect(TAX_NOTICE.version).toBe('1099-misc-v1-2026-04');
    expect(TAX_NOTICE.label).toBe('Tax Reporting Notice');
    expect(TAX_NOTICE.body).toBe(
      'Your $200 referral fee is taxable income. You are responsible for all applicable federal, state, and local taxes on referral income. Otter Quotes does not withhold taxes from referral fee payments. We recommend consulting a qualified tax professional if you have questions about your tax obligations.',
    );
    expect(TAX_NOTICE.body).not.toMatch(/1099|W-9|\$600|January 31/);
  });
  it('the FAQ no longer carries the tax-form question or any 1099 / W-9 promise (D-319)', () => {
    expect(FAQ.map((f) => f.q)).not.toContain('Will I receive a tax form for my referral bonuses?');
    for (const f of FAQ) expect(`${f.q} ${f.a}`).not.toMatch(/1099|W-9|W9/);
  });
  it('D-180 referral-fee approval disclosure (gh-3244: matches refer-a-friend.html @ main; "commission" -> "referral fee", D-301)', () => {
    expect(COMMISSION_APPROVAL_DISCLOSURE).toBe(
      "Referral fee payments are subject to Otter Quotes' approval process. Referral fees are paid after job completion and approval.",
    );
  });
  // D-266: MANDATORY on every referral funnel surface. It was present on
  // refer-a-friend.html but was dropped entirely in the React port, and nothing
  // in CI could see it (tools/partner_parity_check.py only read root-level
  // partner-*.html). Pinned here byte-for-byte and rendered by page.tsx.
  it('D-266 referral-fee legality disclaimer (byte-for-byte, Dustin-dictated)', () => {
    expect(REFERRAL_FEE_DISCLAIMER).toBe(
      'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.',
    );
  });
  it('the $200 / $10,000 representations are intact (hero, How-It-Works, FAQ)', () => {
    expect(HERO.heading).toBe('Love Your Project Results? Share the Love — and Earn $200');
    expect(HERO.subtitle).toContain('completes a project of $10,000 or more');
    expect(HERO.subtitle).toContain('you earn $200');
    expect(HOW_IT_WORKS[2].title).toBe('You Earn $200');
    expect(HOW_IT_WORKS[2].text).toBe('When their job completes ($10K or more), you earn a $200 referral fee.');
    expect(FAQ[2].a).toContain("You won't receive a referral fee for jobs under $10K");
  });
  it('table headers match the static (four columns)', () => {
    expect(REFERRALS.thFriend).toBe("Friend's Name");
    expect(REFERRALS.thDate).toBe('Date Referred');
    expect(REFERRALS.thStatus).toBe('Status');
    expect(REFERRALS.thCommission).toBe('Referral Fee');
    expect(LOGIN_ROUTE).toBe('/login');
  });
});

// ============================================================
// gh-3244 (follow-up to #3242): referral-fee wording, Venmo/PayPal, Partner Agreement v4 acceptance gate
// ============================================================
describe('gh-3244 partner-facing copy', () => {
  const allCopy = (): string[] => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    [HERO, HOW_IT_WORKS, FAQ, AGREEMENT_GATE, TAX_NOTICE, COMMISSION_APPROVAL_DISCLOSURE, REFERRAL_FEE_DISCLAIMER, REFERRALS, REFERRAL_STATUS_LABELS].forEach(walk);
    return out;
  };
  it('no served string says "commission" or "referral bonus" / "bonus payments"', () => {
    for (const s of allCopy()) {
      expect(s).not.toMatch(/commission|referral bonus|bonus payment/i);
    }
  });
  it('payout method is Venmo or PayPal (Agreement Section 5.2), not bank transfer or check', () => {
    const a = FAQ[0].a;
    expect(a).toBe("Referral fees are paid after job completion and approval. We'll send payment via Venmo or PayPal, whichever you prefer.");
    expect(a).not.toMatch(/bank|check/i);
  });
  it('acceptance gate links /partner-agreement.html and names v4-2026-10', () => {
    expect(AGREEMENT_GATE.linkHref).toBe('/partner-agreement.html');
    expect(AGREEMENT_GATE.checkboxSuffix).toContain(PARTNER_AGREEMENT_CURRENT_VERSION);
    expect(PARTNER_AGREEMENT_CURRENT_VERSION).toBe('v4-2026-10');
  });
  it('pre-acceptance subtitle is the conditional line from refer-a-friend.html', () => {
    expect(HERO.subtitlePreAcceptance.startsWith('Once you accept the Partner Agreement, you earn $200')).toBe(true);
  });
});

describe('gh-3244 Partner Agreement v4 acceptance gate', () => {
  it('hasAcceptedAgreementV4: v4 attestation key or v4 version column only', () => {
    expect(hasAcceptedAgreementV4(null)).toBe(false);
    expect(hasAcceptedAgreementV4(undefined)).toBe(false);
    expect(hasAcceptedAgreementV4({})).toBe(false);
    expect(hasAcceptedAgreementV4({ partner_agreement_version: 'v3-2026-09' })).toBe(false);
    expect(hasAcceptedAgreementV4({ partner_agreement_version: 'v3-2026-09', partner_agreement_attestation: { 'v3-2026-09': {} } })).toBe(false);
    expect(hasAcceptedAgreementV4({ partner_agreement_version: 'v4-2026-10' })).toBe(true);
    expect(hasAcceptedAgreementV4({ partner_agreement_attestation: { 'v4-2026-10': { accepted_at: 'x' } } })).toBe(true);
  });

  it('NEGATIVE CONTROL: not accepted -> no link and the code RPC is never called', async () => {
    for (const row of [null, {}, { partner_agreement_version: 'v3-2026-09' }]) {
      const getOrCreateCode = vi.fn(async () => 'ABC123');
      const r = await loadReferLink({ readAgreementRow: async () => row, getOrCreateCode });
      expect(r).toEqual({ state: 'needs_agreement' });
      expect(getOrCreateCode).not.toHaveBeenCalled();
    }
  });
  it('NEGATIVE CONTROL: a failed agreement read fails closed (no link)', async () => {
    const getOrCreateCode = vi.fn(async () => 'ABC123');
    const r = await loadReferLink({ readAgreementRow: async () => { throw new Error('rls'); }, getOrCreateCode });
    expect(r).toEqual({ state: 'needs_agreement' });
    expect(getOrCreateCode).not.toHaveBeenCalled();
  });
  it('POSITIVE: accepted -> link issued', async () => {
    const getOrCreateCode = vi.fn(async () => 'ABC123');
    const r = await loadReferLink({ readAgreementRow: async () => ({ partner_agreement_version: 'v4-2026-10' }), getOrCreateCode });
    expect(r).toEqual({ state: 'link', code: 'ABC123' });
    expect(getOrCreateCode).toHaveBeenCalledTimes(1);
  });
  it('accepted but code RPC fails -> error state, never a fabricated link', async () => {
    const r = await loadReferLink({ readAgreementRow: async () => ({ partner_agreement_version: 'v4-2026-10' }), getOrCreateCode: async () => null });
    expect(r).toEqual({ state: 'error' });
  });

  it('gate submit: get_or_create runs BEFORE accept_partner_agreement_v4, then the code is returned', async () => {
    const calls: string[] = [];
    const code = await acceptAgreementAndIssueLink({
      getOrCreateCode: async () => { calls.push('get_or_create_customer_referral_code'); return 'ABC123'; },
      acceptAgreement: async () => { calls.push('accept_partner_agreement_v4'); return { agreement_version: 'v4-2026-10', accepted_at: '2026-10-31T00:00:00Z', already_accepted: false }; },
    });
    expect(calls).toEqual(['get_or_create_customer_referral_code', 'accept_partner_agreement_v4']);
    expect(code).toBe('ABC123');
  });
  it('NEGATIVE CONTROL: acceptance error / wrong version / no timestamp -> throws, no link returned', async () => {
    const mk = (accept: () => Promise<{ agreement_version?: string | null; accepted_at?: string | null } | null>) =>
      acceptAgreementAndIssueLink({ getOrCreateCode: async () => 'ABC123', acceptAgreement: accept });
    await expect(mk(async () => { throw new Error('rpc'); })).rejects.toThrow();
    await expect(mk(async () => null)).rejects.toThrow();
    await expect(mk(async () => ({ agreement_version: 'v3-2026-09', accepted_at: 'x' }))).rejects.toThrow();
    await expect(mk(async () => ({ agreement_version: 'v4-2026-10', accepted_at: null }))).rejects.toThrow();
  });
  it('no code from the RPC -> accept is never called', async () => {
    const acceptAgreement = vi.fn(async () => ({ agreement_version: 'v4-2026-10', accepted_at: 'x' }));
    await expect(acceptAgreementAndIssueLink({ getOrCreateCode: async () => null, acceptAgreement })).rejects.toThrow();
    expect(acceptAgreement).not.toHaveBeenCalled();
  });
});
