/**
 * P18 (#3219) - partner credit lock, browser side. The database locks the credit to the first partner recorded at account creation
 * and stamps it on the claim whatever the browser sends; adoptLockedReferral() keeps the cookie from carrying a LATER partner's id
 * once the server has said which referral is locked (get_locked_referral_id()).
 *
 * Real `@/lib/cookie-storage` module and the real jsdom cookie jar; nothing about the referral path is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { adoptLockedReferral, readReferralIds, writeReferralIds, clearReferralIds, REFERRAL_MAX_AGE_SECONDS } from '../cookie-storage';

const DAY_MS = 24 * 3600 * 1000;
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

describe('P18: one shared 90-day max-age constant', () => {
  it('REFERRAL_MAX_AGE_SECONDS is 90 days', () => {
    expect(REFERRAL_MAX_AGE_SECONDS).toBe(90 * 24 * 3600);
  });
});

describe('P18: adoptLockedReferral keeps a later click from carrying another partner into the claim', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    clearReferralIds();
  });
  afterEach(() => {
    clearReferralIds();
    vi.useRealTimers();
  });

  it('A clicked and signed up (A locked), B clicked later: the cookie goes back to A and B\'s agent/code are dropped', () => {
    writeReferralIds(B, { click: true }); // the last click is in the cookie
    expect(adoptLockedReferral('ref-A')).toBe(true);
    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('ref-A');
    expect(ids.oq_referral_agent_id).toBeUndefined();
    expect(ids.oq_referral_code).toBeUndefined();
    expect(ids.oq_referral_id_for_claim).toBe('ref-A');
    expect(localStorage.getItem('oq_referral_agent_id')).toBeNull();
  });

  it('keeps the click clock: Max-Age is not re-armed by the swap', () => {
    writeReferralIds(B, { click: true });
    vi.setSystemTime(Date.now() + 40 * DAY_MS);
    adoptLockedReferral('ref-A');
    // 40 days in, the id is still readable at day 89 and gone at day 91 (the clock is B's click, not the swap)
    vi.setSystemTime(Date.now() + 49 * DAY_MS);
    expect(readReferralIds().oq_referral_id).toBe('ref-A');
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    expect(readReferralIds()).toEqual({});
  });

  it('the cookie already holds the locked referral: nothing changes (agent and code stay)', () => {
    writeReferralIds(A, { click: true });
    expect(adoptLockedReferral('ref-A')).toBe(false);
    expect(readReferralIds().oq_referral_agent_id).toBe('agent-A');
  });

  it('no lock (null / undefined / non-string / empty): the cookie is untouched (control)', () => {
    writeReferralIds(B, { click: true });
    for (const v of [null, undefined, true, 7, {}, '']) expect(adoptLockedReferral(v)).toBe(false);
    expect(readReferralIds().oq_referral_id).toBe('ref-B');
    expect(readReferralIds().oq_referral_agent_id).toBe('agent-B');
  });

  it('no cookie on record: nothing is written (the database still stamps the lock on the claim)', () => {
    expect(adoptLockedReferral('ref-A')).toBe(false);
    expect(readReferralIds()).toEqual({});
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('an undated id (no click time) is expired, so there is nothing to swap', () => {
    localStorage.setItem('oq_referral_id', 'ref-B');
    expect(adoptLockedReferral('ref-A')).toBe(false);
    expect(readReferralIds()).toEqual({});
  });

  it('a click 91 days old is gone: nothing to swap, nothing written', () => {
    writeReferralIds(B, { click: true });
    vi.setSystemTime(Date.now() + 91 * DAY_MS);
    expect(adoptLockedReferral('ref-A')).toBe(false);
    expect(readReferralIds()).toEqual({});
  });
});
