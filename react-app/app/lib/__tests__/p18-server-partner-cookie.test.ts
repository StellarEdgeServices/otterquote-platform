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

const RID_A = '11111111-1111-4111-8111-111111111111';
const RID_B = '22222222-2222-4222-8222-222222222222';
const IDS_B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };
function hasPc() {
  return document.cookie.split('; ').some((c) => c.startsWith('oq_pc='));
}
function setPcObj(o: Record<string, unknown>) {
  document.cookie = `oq_pc=${encodeURIComponent(JSON.stringify(o))}; Path=/`;
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

describe('P18 REVIEW 6524205688: last click wins in both directions; forged values rejected; rid carried', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wipe();
  });
  afterEach(() => {
    wipe();
    vi.useRealTimers();
  });

  it('S1: /ref/A then a newer direct click on B; B write deletes oq_pc A; after Safari drops oq-ref A never resurfaces', () => {
    setPc('PARTNERA', NOW);
    writeReferralIds(A, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY_MS));
    writeReferralIds(IDS_B, { click: true });
    expect(hasPc()).toBe(false);
    expect(readReferralIds().oq_referral_code).toBe('PARTNERB');
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY_MS));
    document.cookie = 'oq-ref=; Path=/; Max-Age=0';
    localStorage.clear();
    sessionStorage.clear();
    const ids = readReferralIds();
    expect(ids.oq_referral_code).not.toBe('PARTNERA');
    expect(ids).toEqual({});
  });

  it('S2: oq-ref B passes its window; the older oq_pc A is not returned', () => {
    setPc('PARTNERA', NOW);
    writeReferralIds(A, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + 5 * DAY_MS));
    writeReferralIds(IDS_B, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + 36 * DAY_MS));
    expect(readReferralIds().oq_referral_code).not.toBe('PARTNERA');
  });

  it('read-time purge: newer oq-ref B deletes an older oq_pc A planted after the write', () => {
    writeReferralIds(IDS_B, { click: true });
    setPc('PARTNERA', new Date(NOW.getTime() - 3 * DAY_MS));
    expect(readReferralIds().oq_referral_id).toBe('ref-B');
    expect(hasPc()).toBe(false);
  });

  it('same partner: a click on the same code keeps oq_pc', () => {
    setPc('PARTNERA', NOW);
    writeReferralIds(A, { click: true });
    expect(hasPc()).toBe(true);
  });

  it('expired oq-ref + NEWER in-window oq_pc => oq_pc; expired oq-ref + OLDER oq_pc => nothing, and it is deleted', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY_MS));
    setPc('PARTNERB', new Date());
    vi.setSystemTime(new Date(NOW.getTime() + 35 * DAY_MS));
    expect(readReferralIds().oq_referral_code).toBe('PARTNERB');
    wipe();
    vi.setSystemTime(NOW);
    writeReferralIds(A, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    setPc('PARTNERB', new Date(NOW.getTime() - 5 * DAY_MS));
    vi.setSystemTime(new Date(NOW.getTime() + 32 * DAY_MS));
    expect(readReferralIds()).toEqual({});
    expect(hasPc()).toBe(false);
  });

  it('S3: a future-dated oq_pc never beats a real click', () => {
    setPc('EVIL', new Date(NOW.getTime() + 3650 * DAY_MS));
    writeReferralIds(IDS_B, { click: true });
    const ids = readReferralIds();
    expect(ids.oq_referral_code).toBe('PARTNERB');
    expect(ids.oq_referral_id).toBe('ref-B');
  });

  it('a future-dated oq_pc alone is ignored; 4 minutes of skew is tolerated, 6 is not', () => {
    setPc('EVIL', new Date(NOW.getTime() + 3650 * DAY_MS));
    expect(readReferralIds()).toEqual({});
    wipe();
    setPc('PARTNERA', new Date(NOW.getTime() + 4 * 60 * 1000));
    expect(readReferralIds().oq_referral_code).toBe('PARTNERA');
    wipe();
    setPc('PARTNERA', new Date(NOW.getTime() + 6 * 60 * 1000));
    expect(readReferralIds()).toEqual({});
  });

  it.each([['a;b'], ['x'.repeat(65)], ['<script>'], ['a b']])('oq_pc code %s fails the shape check', (bad) => {
    setPc(bad, NOW);
    expect(readReferralIds()).toEqual({});
  });

  it('oq_pc carrying a valid rid: the fallback returns the referral id too', () => {
    setPcObj({ c: 'PARTNERA', t: NOW.toISOString(), r: RID_A });
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERA', oq_referral_id: RID_A });
  });

  it('oq_pc with a malformed rid: rid ignored, code still returned', () => {
    setPcObj({ c: 'PARTNERA', t: NOW.toISOString(), r: 'not-a-uuid' });
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERA' });
  });

  it('newer B oq_pc with rid beats older A oq-ref and carries the rid', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY_MS));
    setPcObj({ c: 'PARTNERB', t: new Date().toISOString(), r: RID_B });
    expect(readReferralIds()).toEqual({ oq_referral_code: 'PARTNERB', oq_referral_id: RID_B });
  });
});
