/**
 * P18 - server-set partner cookie `oq_pc` (netlify/edge-functions/ref-redirect.ts).
 * Safari caps script-written cookies at 7 days; oq_pc is set by the redirect
 * response, so readReferralIds() falls back to it when oq-ref is missing or
 * expired. Real `@/lib/cookie-storage` module and the real jsdom cookie jar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readReferralIds, writeReferralIds, clearReferralIds } from '../cookie-storage';

const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date('2026-10-01T00:00:00Z');
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };

/** What the edge function emits, minus attributes (jsdom jar needs a plain pair). */
function setPc(code: string, clickAt: Date, raw?: string) {
  const v = raw ?? encodeURIComponent(JSON.stringify({ c: code, t: clickAt.toISOString() }));
  document.cookie = `oq_pc=${v}; Path=/`;
}
function wipe() {
  clearReferralIds();
  document.cookie = 'oq_pc=; Path=/; Max-Age=0';
  document.cookie = 'oq-ref=; Path=/; Max-Age=0';
  localStorage.clear();
  sessionStorage.clear();
}

describe('P18: readReferralIds falls back to oq_pc', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wipe();
  });
  afterEach(() => {
    wipe();
    vi.useRealTimers();
  });

  it('returns the oq_pc code when oq-ref is absent', () => {
    setPc('PARTNERA', new Date(NOW.getTime() - 20 * DAY_MS)); // well past Safari's 7 days
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERA' });
  });

  it('still honours the fallback at day 89 and drops it at day 91', () => {
    setPc('PARTNERA', new Date(NOW.getTime() - 89 * DAY_MS));
    expect(readReferralIds().oq_referral_code).toBe('PARTNERA');
    wipe();
    setPc('PARTNERA', new Date(NOW.getTime() - 91 * DAY_MS));
    expect(readReferralIds()).toEqual({});
  });

  it('oq-ref wins when it holds ids (oq_pc never overrides the richer cookie)', () => {
    writeReferralIds(A, { click: true });
    setPc('OTHERCODE', new Date(NOW.getTime() - DAY_MS));
    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('ref-A');
    expect(ids.oq_referral_code).toBe('PARTNERA');
  });

  it('uses oq_pc once oq-ref has been dropped (script cookie expired, server cookie alive)', () => {
    writeReferralIds(A, { click: true });
    setPc('PARTNERA', NOW);
    document.cookie = 'oq-ref=; Path=/; Max-Age=0'; // Safari dropped the script cookie
    localStorage.clear();
    sessionStorage.clear();
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERA' });
  });

  it('stale storage ids with no click time are purged but a valid oq_pc survives and attributes', () => {
    localStorage.setItem('oq_referral_id', 'ref-stale'); // oq-ref gone, mirror left behind, no click time
    setPc('PARTNERA', new Date(NOW.getTime() - 10 * DAY_MS));
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERA' });
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
    expect(document.cookie).toContain('oq_pc=');
  });

  describe('last click wins between oq-ref and oq_pc', () => {
    const B_CODE = 'PARTNERB';
    it('older A in oq-ref + newer B in oq_pc => B, and A\'s stale ids are gone', () => {
      writeReferralIds(A, { click: true }); // click at NOW
      vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY_MS));
      setPc(B_CODE, new Date()); // B clicked 3 days later, server-side only
      expect(readReferralIds()).toEqual({ oq_referral_code: B_CODE });
      expect(localStorage.getItem('oq_referral_id')).toBeNull();
      expect(readReferralIds()).toEqual({ oq_referral_code: B_CODE }); // stable on re-read
    });

    it('newer A in oq-ref + older B in oq_pc => A', () => {
      setPc(B_CODE, new Date(NOW.getTime() - 5 * DAY_MS));
      writeReferralIds(A, { click: true }); // click at NOW, newer
      const ids = readReferralIds();
      expect(ids.oq_referral_id).toBe('ref-A');
      expect(ids.oq_referral_code).toBe('PARTNERA');
    });

    it('same partner, newer oq_pc => oq-ref ids are kept (nothing stale to drop)', () => {
      writeReferralIds(A, { click: true });
      vi.setSystemTime(new Date(NOW.getTime() + DAY_MS));
      setPc('PARTNERA', new Date());
      expect(readReferralIds().oq_referral_id).toBe('ref-A');
    });

    it('oq-ref with no click time (legacy) => in-window oq_pc wins', () => {
      document.cookie = `oq-ref=${encodeURIComponent(JSON.stringify(A))}; Path=/`; // no oq_referral_ts
      setPc(B_CODE, new Date(NOW.getTime() - DAY_MS));
      expect(readReferralIds()).toEqual({ oq_referral_code: B_CODE });
    });

    it('negative control: an oq_pc outside the 90-day window is ignored and the in-window oq-ref is returned', () => {
      writeReferralIds(A, { click: true });
      setPc(B_CODE, new Date(NOW.getTime() - 91 * DAY_MS));
      expect(readReferralIds().oq_referral_id).toBe('ref-A');
    });
  });

  it('negative control: no oq_pc and no oq-ref returns nothing', () => {
    expect(readReferralIds()).toEqual({});
  });

  it.each([
    ['not JSON', 'garbage'],
    ['no code', encodeURIComponent(JSON.stringify({ t: NOW.toISOString() }))],
    ['bad time', encodeURIComponent(JSON.stringify({ c: 'X', t: 'yesterday' }))],
    ['code is not a string', encodeURIComponent(JSON.stringify({ c: 5, t: NOW.toISOString() }))],
  ])('negative control: malformed oq_pc (%s) is ignored', (_label, raw) => {
    setPc('', NOW, raw);
    expect(readReferralIds()).toEqual({});
  });

  it('clearReferralIds removes oq_pc so a consumed attribution does not come back', () => {
    setPc('PARTNERA', NOW);
    expect(readReferralIds().oq_referral_code).toBe('PARTNERA');
    clearReferralIds();
    expect(readReferralIds()).toEqual({});
  });
});
