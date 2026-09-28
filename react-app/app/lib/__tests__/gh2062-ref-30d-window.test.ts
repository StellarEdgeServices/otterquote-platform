/**
 * gh-2062 (CEO ruling, issue comment 5874597169) — React twin of
 * tests/gh2062-ref-30d-window.mjs. The `oq-ref` attribution window is 30 days
 * from the partner-link click, re-armed only by a fresh click
 * (`writeReferralIds(ids, { click: true })`), never by the auth-callback
 * advance write (`writeReferralIds(ids)`).
 *
 * Real `@/lib/cookie-storage` module, real jsdom cookie jar (which honours
 * Max-Age against the faked clock); nothing about the referral path is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readReferralIds, writeReferralIds, clearReferralIds, REFERRAL_MAX_AGE_SECONDS } from '../cookie-storage';

const DAY_MS = 24 * 3600 * 1000;
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

let cookieWrites: string[] = [];
let restoreSetter: () => void = () => {};

function spyOnCookieSetter() {
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => desc.get!.call(document),
    set: (v: string) => { cookieWrites.push(v); desc.set!.call(document, v); },
  });
  restoreSetter = () => { delete (document as unknown as Record<string, unknown>).cookie; };
}
const lastOqRefMaxAge = (): number | null => {
  const w = [...cookieWrites].reverse().find((s) => s.startsWith('oq-ref=') && !/Max-Age=0\b/.test(s));
  const m = w && /Max-Age=(\d+)/.exec(w);
  return m ? Number(m[1]) : null;
};
const cookieJarHasOqRef = () => document.cookie.split('; ').some((p) => p.startsWith('oq-ref='));

describe('gh-2062: 30-day, click-anchored oq-ref window (real cookie)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    cookieWrites = [];
    spyOnCookieSetter();
    clearReferralIds();
    cookieWrites = [];
  });
  afterEach(() => {
    clearReferralIds();
    restoreSetter();
    vi.useRealTimers();
  });

  it('the window constant is 30 days', () => {
    expect(REFERRAL_MAX_AGE_SECONDS).toBe(30 * 24 * 3600);
  });

  it('a click arms exactly 30 days and attributes (positive control)', () => {
    writeReferralIds(A, { click: true });
    expect(lastOqRefMaxAge()).toBe(30 * 24 * 3600);
    expect(readReferralIds().oq_referral_id).toBe('ref-A');
    expect(Object.keys(readReferralIds())).not.toContain('oq_referral_ts');
  });

  it('advance-block writes (no click) never re-arm: Max-Age is the time remaining', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    writeReferralIds(A); // what auth-callback does on success / no-op / error
    expect(lastOqRefMaxAge()).toBe(20 * 24 * 3600);
    vi.setSystemTime(Date.now() + 19 * DAY_MS);
    writeReferralIds(A);
    expect(lastOqRefMaxAge()).toBe(1 * 24 * 3600);
    expect(readReferralIds().oq_referral_id).toBe('ref-A'); // day 29: still inside the window
  });

  it('day 31: cookie expired AND the storage mirror does not resurrect the id', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    writeReferralIds(A);
    vi.setSystemTime(Date.now() + 21 * DAY_MS);
    expect(cookieJarHasOqRef()).toBe(false);
    expect(readReferralIds()).toEqual({});
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('a non-click write with no click on record does not arm a cookie', () => {
    writeReferralIds(A);
    expect(cookieJarHasOqRef()).toBe(false);
  });

  it('a fresh click re-arms a full 30 days and the last click wins', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(Date.now() + 20 * DAY_MS);
    writeReferralIds(B, { click: true });
    expect(lastOqRefMaxAge()).toBe(30 * 24 * 3600);
    expect(readReferralIds().oq_referral_id).toBe('ref-B');
    expect(readReferralIds().oq_referral_agent_id).toBe('agent-B');
  });

  it('clearReferralIds() removes the clock too: a later non-click write cannot resurrect a cookie', () => {
    writeReferralIds(A, { click: true });
    clearReferralIds();
    expect(cookieJarHasOqRef()).toBe(false);
    writeReferralIds(A);
    expect(cookieJarHasOqRef()).toBe(false);
  });
});
