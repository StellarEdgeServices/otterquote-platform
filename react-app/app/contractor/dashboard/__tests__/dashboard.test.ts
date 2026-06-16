/**
 * Parity + unit tests for the contractor dashboard (D-211 Phase 2).
 *
 *  1. TIER-3 verbatim copy: the CPA acceptance / D-230 re-attestation modal copy
 *     is asserted BYTE-FOR-BYTE against contractor-dashboard.html @ main. Any edit
 *     to ./copy.ts trips this — that is the intended Tier-3 tripwire.
 *  2. Ported pure logic (./utils): activity time, D-074 location privacy, material
 *     label, earnings format, profile-completion, the opportunities filter, etc.
 */

import { describe, it, expect } from 'vitest';
import { DASHBOARD_COPY } from '../copy';
import { CURRENT_CPA_VERSION } from '../../_shell/cpa-guard';
import {
  formatActivityTime, buildLocation, buildMaterial, formatEarnings, formatMoney,
  titleCase, calculateProfileCompletion, profileChecklist, filterOpportunities,
  serviceAreaDisplay, efUrl, activityDotColor, type OppClaim,
} from '../utils';

// ── Exact strings from contractor-dashboard.html @ main ──
const STATIC = {
  agreement: {
    title: 'Contractor Partner Agreement',
    intro: 'Before using Otter Quotes, please review and accept our Contractor Partner Agreement.',
    readLink: '📄 Read Full Agreement',
    checkboxLabel: 'I have read and agree to the Otter Quotes Contractor Partner Agreement',
    accept: 'Accept and Continue',
  },
  cpa: {
    title: 'Updated Contractor Agreement',
    intro:
      "We've updated our Contractor Partner Agreement. Please review the changes and re-accept to continue using Otter Quotes.",
    readLink: 'View the updated agreement →',
    checkboxLabel:
      'I have read and accept the updated Contractor Partner Agreement (version v1-2026-04)',
    accept: 'Accept and Continue',
  },
};

describe('TIER-3 verbatim CPA / agreement modal copy (byte-for-byte)', () => {
  it('first-time agreement modal matches contractor-dashboard.html exactly', () => {
    expect(DASHBOARD_COPY.agreementModal.title).toBe(STATIC.agreement.title);
    expect(DASHBOARD_COPY.agreementModal.intro).toBe(STATIC.agreement.intro);
    expect(DASHBOARD_COPY.agreementModal.readLink).toBe(STATIC.agreement.readLink);
    expect(DASHBOARD_COPY.agreementModal.checkboxLabel).toBe(STATIC.agreement.checkboxLabel);
    expect(DASHBOARD_COPY.agreementModal.accept).toBe(STATIC.agreement.accept);
  });
  it('D-230 re-attestation modal matches contractor-dashboard.html exactly', () => {
    expect(DASHBOARD_COPY.cpaReacceptModal.title).toBe(STATIC.cpa.title);
    expect(DASHBOARD_COPY.cpaReacceptModal.intro).toBe(STATIC.cpa.intro);
    expect(DASHBOARD_COPY.cpaReacceptModal.readLink).toBe(STATIC.cpa.readLink);
    expect(DASHBOARD_COPY.cpaReacceptModal.checkboxLabel).toBe(STATIC.cpa.checkboxLabel);
    expect(DASHBOARD_COPY.cpaReacceptModal.accept).toBe(STATIC.cpa.accept);
  });
  it('the locked checkbox label embeds the current CPA version', () => {
    expect(DASHBOARD_COPY.cpaReacceptModal.checkboxLabel).toContain(`(version ${CURRENT_CPA_VERSION})`);
  });
});

describe('formatActivityTime', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('buckets relative times like the static feed', () => {
    expect(formatActivityTime(ago(30 * 1000), now)).toBe('Just now');
    expect(formatActivityTime(ago(60 * 1000), now)).toBe('1 minute ago');
    expect(formatActivityTime(ago(5 * 60 * 1000), now)).toBe('5 minutes ago');
    expect(formatActivityTime(ago(60 * 60 * 1000), now)).toBe('1 hour ago');
    expect(formatActivityTime(ago(3 * 24 * 60 * 60 * 1000), now)).toBe('3 days ago');
    expect(formatActivityTime(ago(10 * 24 * 60 * 60 * 1000), now)).toMatch(/2026/);
  });
});

describe('buildLocation (D-074 privacy)', () => {
  it('reveals the full address once awarded/selected/completed', () => {
    expect(buildLocation('123 Main St, Carmel, IN 46032', 'awarded')).toBe('123 Main St, Carmel, IN 46032');
    expect(buildLocation('123 Main St, Carmel, IN 46032', 'completed')).toBe('123 Main St, Carmel, IN 46032');
  });
  it('shows only city + zip while a bid is pending (submitted)', () => {
    expect(buildLocation('123 Main St, Carmel, IN 46032', 'submitted')).toBe('Carmel, IN 46032');
  });
  it('handles unknown address', () => {
    expect(buildLocation('', 'awarded')).toBe('Unknown');
  });
});

describe('buildMaterial / formatEarnings / formatMoney / titleCase', () => {
  it('builds material labels', () => {
    expect(buildMaterial({ material_category: 'shingles', shingle_type: 'architectural' })).toBe('Architectural Shingles');
    expect(buildMaterial({ material_category: 'metal' })).toBe('Metal');
    expect(buildMaterial({})).toBe('Not specified');
    expect(buildMaterial(null)).toBe('Not specified');
  });
  it('formats earnings with exact 2dp (Bug 7)', () => {
    expect(formatEarnings(637.5)).toBe('$637.50');
    expect(formatEarnings(0)).toBe('$0.00');
  });
  it('formats money + titleCase with fallbacks', () => {
    expect(formatMoney(1500)).toBe('$1,500');
    expect(formatMoney(null)).toBe('—');
    expect(titleCase('roofing')).toBe('Roofing');
    expect(titleCase(null, 'Roofing')).toBe('Roofing');
  });
});

describe('profile completion checklist', () => {
  it('counts the 7 steps and marks done correctly', () => {
    const partial = { company_name: 'Acme', agreement_accepted_at: '2026-01-01' };
    const { completedCount, totalSteps } = calculateProfileCompletion(partial);
    expect(totalSteps).toBe(7);
    expect(completedCount).toBe(2);
    const items = profileChecklist(partial);
    expect(items.find((i) => i.key === 'business')?.done).toBe(true);
    expect(items.find((i) => i.key === 'paymentMethod')?.done).toBe(false);
  });
});

describe('filterOpportunities (trade filter + max-6 bids + already-bid)', () => {
  const claims: OppClaim[] = [
    { id: 'a', selected_trades: ['roofing'] },
    { id: 'b', selected_trades: ['siding'] },
    { id: 'c', trades: 'roofing' },
    { id: 'd', selected_trades: ['roofing'] },
  ];
  it('keeps only trade-matching, under-cap, not-already-bid claims', () => {
    const out = filterOpportunities(
      claims,
      ['roofing'],                 // contractor trades
      { d: 6 },                    // d is at the 6-bid cap (D-030) → excluded
      new Set(['a']),              // already bid on a → excluded
    );
    expect(out.map((c) => c.id)).toEqual(['c']); // b=wrong trade, a=already bid, d=capped
  });
  it('with no trades set, keeps all non-capped/not-bid claims', () => {
    const out = filterOpportunities(claims, [], {}, new Set());
    expect(out).toHaveLength(4);
  });
});

describe('serviceAreaDisplay / efUrl / activityDotColor', () => {
  it('normalizes county formats', () => {
    expect(serviceAreaDisplay(['IN:Hamilton', 'Boone'])).toEqual(['Hamilton', 'Boone']);
    expect(serviceAreaDisplay(null)).toEqual([]);
  });
  it('builds an EF URL ending in the function path', () => {
    expect(efUrl('mark-job-complete').endsWith('/functions/v1/mark-job-complete')).toBe(true);
  });
  it('maps activity dot colors', () => {
    expect(activityDotColor('bid_accepted')).toBe('#15803D');
    expect(activityDotColor('whatever')).toBe('#6B7280');
  });
});
