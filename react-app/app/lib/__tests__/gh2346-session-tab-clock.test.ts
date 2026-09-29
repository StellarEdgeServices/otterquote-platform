/**
 * gh-2346 (money, D-301 referral attribution) - React twin of
 * tests/gh2346-session-tab-clock.mjs. sessionStorage is PER TAB but there is
 * ONE click clock (oq_referral_ts: cookie + localStorage). A newer click in
 * another tab must not make an older tab's sessionStorage ids look in-window;
 * and a click write must clear keys it does not carry.
 *
 * Real `@/lib/cookie-storage` module; the two tabs share jsdom's real
 * localStorage and the faked clock, and swap in a separate sessionStorage
 * object each. Cookies are OFF (document.cookie is a black hole), the hard case
 * in the issue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readReferralIds, writeReferralIds, clearReferralIds } from '../cookie-storage';

const DAY_MS = 24 * 3600 * 1000;
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}

const realSession = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
const tab1 = makeStorage();
const tab2 = makeStorage();
function switchToTab(s: Storage) {
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: s });
}

/** What trade-selector/page.tsx does at claim time: windowed reader FIRST, then RAW fallbacks. */
function claimId(): string | null {
  const r = readReferralIds();
  return r.oq_referral_id || sessionStorage.getItem('oq_referral_id') || localStorage.getItem('oq_referral_id') || r.oq_referral_id_for_claim || null;
}
function claimAgent(): string | null {
  const r = readReferralIds();
  return r.oq_referral_agent_id || sessionStorage.getItem('oq_referral_agent_id') || localStorage.getItem('oq_referral_agent_id') || null;
}

describe('gh-2346: per-tab click stamp for sessionStorage referral ids (cookies off)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} });
    for (const s of [tab1, tab2]) s.clear();
    localStorage.clear();
    switchToTab(tab1);
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).cookie;
    if (realSession) Object.defineProperty(window, 'sessionStorage', realSession);
    localStorage.clear();
    vi.useRealTimers();
  });

  it('TWO-TAB: tab 1 clicks A day 0, tab 2 clicks B day 40; the claim from tab 1 yields B, never A', () => {
    switchToTab(tab1);
    writeReferralIds(A, { click: true });
    vi.setSystemTime(Date.now() + 40 * DAY_MS);
    switchToTab(tab2);
    writeReferralIds({ oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' }, { click: true });

    switchToTab(tab1);
    const got = claimId();
    const agent = claimAgent();
    console.log(`(info) tab-1 claim at day 40 yields id=${got} agent=${agent}`);
    expect(got).not.toBe('ref-A');
    expect(got).toBe('ref-B');
    expect(agent).toBe('agent-B');
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull(); // raw fallbacks are starved

    switchToTab(tab2);
    expect(claimId()).toBe('ref-B');
  });

  it('POSITIVE CONTROL: same tab, in window, still attributes (read() and the raw session fallback)', () => {
    writeReferralIds(A, { click: true });
    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    expect(readReferralIds().oq_referral_id).toBe('ref-A');
    expect(claimId()).toBe('ref-A');
    expect(claimAgent()).toBe('agent-A');
    expect(sessionStorage.getItem('oq_referral_id')).toBe('ref-A'); // this tab's own ids are not purged
    vi.setSystemTime(Date.now() + 19 * DAY_MS); // day 29
    expect(claimId()).toBe('ref-A');
    writeReferralIds(A); // auth-callback advance-block write (no click) keeps the stamp equal to the clock
    expect(claimId()).toBe('ref-A');
  });

  it('unstamped sessionStorage ids are dropped even in-window; localStorage (the clock mirror) wins', () => {
    writeReferralIds({ oq_referral_id: 'ref-B' }, { click: true });
    sessionStorage.removeItem('oq_referral_ts');
    sessionStorage.setItem('oq_referral_id', 'ref-STALE');
    expect(claimId()).toBe('ref-B');
  });

  it('a stamp older than 30 days is not trusted', () => {
    writeReferralIds(A, { click: true });
    sessionStorage.setItem('oq_referral_ts', String(Date.now() - 31 * DAY_MS));
    readReferralIds();
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('a write with absent keys clears them from local+sessionStorage (A agent/code never pair with B id)', () => {
    writeReferralIds(A, { click: true });
    writeReferralIds({ oq_referral_id: 'ref-B' }, { click: true });
    expect(localStorage.getItem('oq_referral_agent_id')).toBeNull();
    expect(localStorage.getItem('oq_referral_code')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_agent_id')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_code')).toBeNull();
    const r = readReferralIds();
    expect(r.oq_referral_id).toBe('ref-B');
    expect(r.oq_referral_agent_id).toBeUndefined();
    expect(r.oq_referral_code).toBeUndefined();
    expect(claimAgent()).toBeNull();
  });

  it('clearReferralIds also drops the tab stamp', () => {
    writeReferralIds(A, { click: true });
    expect(sessionStorage.getItem('oq_referral_ts')).not.toBeNull();
    clearReferralIds();
    expect(sessionStorage.getItem('oq_referral_ts')).toBeNull();
  });
});
