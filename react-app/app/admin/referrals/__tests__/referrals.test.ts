/**
 * Unit + parity tests for Admin Referral Partners pure logic (D-211 Phase 11).
 *
 * Pins against admin-referrals.html @ main behavior:
 *   (a) referral_agents READ shape  → REFERRAL_AGENTS_SELECT (byte-for-byte)
 *   (b) payments_blocked WRITE       → unblockPayload() byte-identical; verifyW9Payload()
 *   (c) W-9 viewer wiring            → W9_BUCKET / W9_SIGNED_URL_TTL_SECONDS
 *   (d) the gate                     → RequireAdmin tier="super" ⇒ isSuperAdminEmail
 *   (e) verbatim tax/legal copy      → W-9 status labels + UNBLOCK_CONFIRM_TEXT
 *
 * Plus filterPartners, summaryCards, fullName, fmtDate, typeBadge, paymentsBadge,
 * and the buildActions() visibility predicates.
 *
 * No network / supabase calls — all helpers are side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import { isSuperAdminEmail } from '@/lib/admin-allowlist';
import {
  type ReferralAgent,
  REFERRAL_AGENTS_SELECT,
  REFERRAL_FILTERS,
  filterPartners,
  summaryCards,
  fullName,
  fmtDate,
  w9StatusBadge,
  typeBadge,
  paymentsBadge,
  showViewW9,
  showVerifyW9,
  showUnblock,
  verifyW9Payload,
  unblockPayload,
  W9_BUCKET,
  W9_SIGNED_URL_TTL_SECONDS,
  UNBLOCK_CONFIRM_TEXT,
} from '../utils';

// ── Fixture helper ─────────────────────────────────────────────────────────────

function mkAgent(over: Partial<ReferralAgent> = {}): ReferralAgent {
  return {
    id: over.id ?? 'a-1',
    first_name: over.first_name ?? 'Jane',
    last_name: over.last_name ?? 'Doe',
    email: over.email ?? 'jane@example.com',
    agent_type: over.agent_type ?? 're_agent',
    created_at: over.created_at ?? '2026-06-10T12:00:00Z',
    payments_blocked: over.payments_blocked ?? false,
    w9_file_url: over.w9_file_url ?? null,
    w9_submitted_at: over.w9_submitted_at ?? null,
    w9_verified_at: over.w9_verified_at ?? null,
    w9_notification_sent_at: over.w9_notification_sent_at ?? null,
    ...over,
  };
}

// ── (a) READ shape — UNCHANGED CONTRACT (Tier-3) ───────────────────────────────

describe('REFERRAL_AGENTS_SELECT — byte-for-byte read shape', () => {
  it('matches admin-referrals.html:435 exactly', () => {
    expect(REFERRAL_AGENTS_SELECT).toBe(
      'id, first_name, last_name, email, agent_type, created_at, payments_blocked, w9_file_url, w9_submitted_at, w9_verified_at, w9_notification_sent_at',
    );
  });

  it('contains the W-9 + payment-block columns the admin dashboard relies on', () => {
    for (const col of [
      'payments_blocked',
      'w9_file_url',
      'w9_submitted_at',
      'w9_verified_at',
      'w9_notification_sent_at',
    ]) {
      expect(REFERRAL_AGENTS_SELECT).toContain(col);
    }
  });
});

// ── (b) WRITE payloads — UNCHANGED CONTRACTS (Tier-3) ──────────────────────────

describe('unblockPayload — payments_blocked write byte-identical to static', () => {
  it('returns exactly { payments_blocked: false }', () => {
    expect(unblockPayload()).toEqual({ payments_blocked: false });
  });
  it('has exactly one key', () => {
    expect(Object.keys(unblockPayload())).toEqual(['payments_blocked']);
  });
});

describe('verifyW9Payload — verify-W9 write byte-identical to static', () => {
  it('returns exactly { w9_verified_at: <iso> } with the injected timestamp', () => {
    const iso = '2026-06-17T18:30:00.000Z';
    expect(verifyW9Payload(iso)).toEqual({ w9_verified_at: iso });
  });
  it('has exactly one key', () => {
    expect(Object.keys(verifyW9Payload('x'))).toEqual(['w9_verified_at']);
  });
});

// ── (c) W-9 viewer wiring — UNCHANGED CONTRACT (Tier-3) ────────────────────────

describe('W-9 viewer contract', () => {
  it('bucket is "partner-w9"', () => {
    expect(W9_BUCKET).toBe('partner-w9');
  });
  it('signed-URL TTL is 60 seconds', () => {
    expect(W9_SIGNED_URL_TTL_SECONDS).toBe(60);
  });
});

// ── (d) Gate — RequireAdmin tier="super" ⇒ isSuperAdminEmail ───────────────────

describe('gate parity (RequireAdmin tier="super")', () => {
  it("admits the static page's sole hardcoded admin email (parity preserved)", () => {
    expect(isSuperAdminEmail('dustinstohler1@gmail.com')).toBe(true);
  });

  it('DIVERGENCE (flagged, not fixed): the super allow-list also admits dustin@otterquote.com, which the static single-email gate did NOT', () => {
    expect(isSuperAdminEmail('dustin@otterquote.com')).toBe(true);
  });

  it('rejects a non-allow-listed email', () => {
    expect(isSuperAdminEmail('attacker@example.com')).toBe(false);
    expect(isSuperAdminEmail(null)).toBe(false);
    expect(isSuperAdminEmail(undefined)).toBe(false);
  });
});

// ── (e) Verbatim copy ───────────────────────────────────────────────────────

describe('verbatim W-9 / unblock copy', () => {
  it('UNBLOCK_CONFIRM_TEXT is byte-for-byte the static confirm() string', () => {
    expect(UNBLOCK_CONFIRM_TEXT).toBe(
      'Manually unblock this partner without a W-9 on file? Only do this for grandfathered or exceptional cases.',
    );
  });

  it('W-9 status labels match the static badges exactly', () => {
    expect(w9StatusBadge(mkAgent({ w9_verified_at: '2026-06-01T00:00:00Z' })).label).toBe(
      '✅ Verified',
    );
    expect(w9StatusBadge(mkAgent({ w9_submitted_at: '2026-06-01T00:00:00Z' })).label).toBe(
      '📋 Pending Review',
    );
    expect(
      w9StatusBadge(mkAgent({ w9_notification_sent_at: '2026-06-01T00:00:00Z' })).label,
    ).toBe('⚠️ Notified — Not Filed');
    expect(w9StatusBadge(mkAgent()).label).toBe('Not Required Yet');
  });
});

// ── REFERRAL_FILTERS ───────────────────────────────────────────────────────────

describe('REFERRAL_FILTERS', () => {
  it('exposes exactly 4 keys in the correct order', () => {
    expect(REFERRAL_FILTERS.map((f) => f.key)).toEqual([
      'all',
      'blocked',
      'pending_review',
      'verified',
    ]);
  });
  it('labels match the static tab text (with emoji)', () => {
    expect(REFERRAL_FILTERS.map((f) => f.label)).toEqual([
      'All Partners',
      '⚠️ Blocked',
      '📋 Pending Review',
      '✅ Verified',
    ]);
  });
});

// ── filterPartners ─────────────────────────────────────────────────────────────

describe('filterPartners', () => {
  const rows: ReferralAgent[] = [
    mkAgent({ id: 'r-blocked', payments_blocked: true }),
    mkAgent({ id: 'r-pending', w9_submitted_at: '2026-06-02T00:00:00Z', w9_verified_at: null }),
    mkAgent({ id: 'r-verified', w9_verified_at: '2026-06-03T00:00:00Z' }),
    mkAgent({ id: 'r-plain' }),
  ];

  it('"all" returns every row', () => {
    expect(filterPartners(rows, 'all')).toHaveLength(4);
    expect(filterPartners(rows, 'all')).toEqual(rows);
  });
  it('"blocked" → only payments_blocked rows', () => {
    const r = filterPartners(rows, 'blocked');
    expect(r.map((x) => x.id)).toEqual(['r-blocked']);
  });
  it('"pending_review" → submitted but not verified', () => {
    const r = filterPartners(rows, 'pending_review');
    expect(r.map((x) => x.id)).toEqual(['r-pending']);
  });
  it('"verified" → only w9_verified_at rows', () => {
    const r = filterPartners(rows, 'verified');
    expect(r.map((x) => x.id)).toEqual(['r-verified']);
  });
  it('a verified+submitted row is NOT counted as pending_review', () => {
    const both = mkAgent({
      id: 'both',
      w9_submitted_at: '2026-06-01T00:00:00Z',
      w9_verified_at: '2026-06-04T00:00:00Z',
    });
    expect(filterPartners([both], 'pending_review')).toHaveLength(0);
    expect(filterPartners([both], 'verified')).toHaveLength(1);
  });
  it('empty input returns empty for any filter', () => {
    expect(filterPartners([], 'all')).toEqual([]);
    expect(filterPartners([], 'blocked')).toEqual([]);
  });
});

// ── summaryCards ─────────────────────────────────────────────────────────────

describe('summaryCards', () => {
  it('counts total / blocked / pendingReview / verified exactly like updateSummaryCards()', () => {
    const rows: ReferralAgent[] = [
      mkAgent({ id: '1', payments_blocked: true }),
      mkAgent({ id: '2', w9_submitted_at: '2026-06-01T00:00:00Z', w9_verified_at: null }),
      mkAgent({ id: '3', w9_verified_at: '2026-06-02T00:00:00Z' }),
      mkAgent({ id: '4' }),
      // submitted AND verified → verified yes, pendingReview no
      mkAgent({ id: '5', w9_submitted_at: '2026-06-01T00:00:00Z', w9_verified_at: '2026-06-03T00:00:00Z' }),
    ];
    expect(summaryCards(rows)).toEqual({
      total: 5,
      blocked: 1,
      pendingReview: 1,
      verified: 2,
    });
  });
  it('returns zeros for empty array', () => {
    expect(summaryCards([])).toEqual({ total: 0, blocked: 0, pendingReview: 0, verified: 0 });
  });
});

// ── fullName ───────────────────────────────────────────────────────────────────

describe('fullName', () => {
  it('joins first + last', () => {
    expect(fullName({ first_name: 'Jane', last_name: 'Doe' })).toBe('Jane Doe');
  });
  it('drops a falsy half', () => {
    expect(fullName({ first_name: 'Jane', last_name: null })).toBe('Jane');
    expect(fullName({ first_name: null, last_name: 'Doe' })).toBe('Doe');
  });
  it('both empty → "—"', () => {
    expect(fullName({ first_name: null, last_name: null })).toBe('—');
    expect(fullName({ first_name: '', last_name: '' })).toBe('—');
  });
});

// ── fmtDate ────────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('null/undefined/empty → "—"', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
  });
  it('a valid ISO → en-US short month/day/year', () => {
    expect(fmtDate('2026-06-17T12:00:00Z')).toBe(
      new Date('2026-06-17T12:00:00Z').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
  });
});

// ── typeBadge ────────────────────────────────────────────────────────────────

describe('typeBadge', () => {
  it('maps all six known agent types (gh-914: adjuster/other were previously silently absent, falling to the unknown-type branch)', () => {
    expect(typeBadge('re_agent')).toEqual({ label: 'Real Estate Agent', className: 'badge-type-re' });
    expect(typeBadge('insurance_agent')).toEqual({ label: 'Insurance', className: 'badge-type-ins' });
    expect(typeBadge('home_inspector')).toEqual({ label: 'Inspector', className: 'badge-type-insp' });
    expect(typeBadge('customer')).toEqual({ label: 'Customer', className: 'badge-type-cust' });
    expect(typeBadge('adjuster')).toEqual({ label: 'Adjuster', className: 'badge-type-ins' });
    expect(typeBadge('other')).toEqual({ label: 'Other', className: 'badge-type-cust' });
  });
  it('unknown type → raw value with badge-not-filed', () => {
    expect(typeBadge('weird')).toEqual({ label: 'weird', className: 'badge-not-filed' });
  });
  it('null/undefined → "—" with badge-not-filed', () => {
    expect(typeBadge(null)).toEqual({ label: '—', className: 'badge-not-filed' });
    expect(typeBadge(undefined)).toEqual({ label: '—', className: 'badge-not-filed' });
  });
});

// ── paymentsBadge ──────────────────────────────────────────────────────────────

describe('paymentsBadge', () => {
  it('blocked → Blocked / badge-blocked', () => {
    expect(paymentsBadge(mkAgent({ payments_blocked: true }))).toEqual({
      label: 'Blocked',
      className: 'badge-blocked',
    });
  });
  it('not blocked → Enabled / badge-verified', () => {
    expect(paymentsBadge(mkAgent({ payments_blocked: false }))).toEqual({
      label: 'Enabled',
      className: 'badge-verified',
    });
  });
});

// ── Action visibility predicates (buildActions parity) ─────────────────────────

describe('action visibility predicates', () => {
  it('showViewW9 ⇔ w9_file_url present', () => {
    expect(showViewW9(mkAgent({ w9_file_url: 'partners/a-1/w9.pdf' }))).toBe(true);
    expect(showViewW9(mkAgent({ w9_file_url: null }))).toBe(false);
  });
  it('showVerifyW9 ⇔ submitted AND not verified', () => {
    expect(showVerifyW9(mkAgent({ w9_submitted_at: 'x', w9_verified_at: null }))).toBe(true);
    expect(showVerifyW9(mkAgent({ w9_submitted_at: 'x', w9_verified_at: 'y' }))).toBe(false);
    expect(showVerifyW9(mkAgent({ w9_submitted_at: null }))).toBe(false);
  });
  it('showUnblock ⇔ blocked AND no submission', () => {
    expect(showUnblock(mkAgent({ payments_blocked: true, w9_submitted_at: null }))).toBe(true);
    expect(showUnblock(mkAgent({ payments_blocked: true, w9_submitted_at: 'x' }))).toBe(false);
    expect(showUnblock(mkAgent({ payments_blocked: false }))).toBe(false);
  });
});
