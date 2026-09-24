// gh-2107 / D-330 -- the advertising-sharing opt-out as the browser sees it (Ben's ruling on #2078, 5805593465, item a:
// "For GPC=1 or ad_sharing_opt_out = true, the Meta pixel does not load"). Written before lib/ad-optout.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AD_OPTOUT_COOKIE,
  gpcOptOut,
  hasAdOptOutCookie,
  isAdSharingOptedOut,
  readStoredOptOut,
  recordAdOptOutCookie,
  type ProfileReader,
} from '../ad-optout';

function clearCookie() {
  document.cookie = `${AD_OPTOUT_COOKIE}=; max-age=0; path=/`;
}

describe('gpcOptOut', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is true only when navigator.globalPrivacyControl is exactly true', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    expect(gpcOptOut()).toBe(true);
  });

  it.each([[false], [undefined], ['true'], [1], [null]])('is false when it is %s', (v) => {
    vi.stubGlobal('navigator', { globalPrivacyControl: v });
    expect(gpcOptOut()).toBe(false);
  });

  it('is false with no navigator, and never throws when reading the property throws', () => {
    vi.stubGlobal('navigator', undefined);
    expect(gpcOptOut()).toBe(false);
    const nav = {} as Record<string, unknown>;
    Object.defineProperty(nav, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
    vi.stubGlobal('navigator', nav);
    expect(() => gpcOptOut()).not.toThrow();
    expect(gpcOptOut()).toBe(false);
  });
});

describe('the oq_ad_optout cookie', () => {
  beforeEach(clearCookie);
  afterEach(() => { clearCookie(); vi.unstubAllGlobals(); });

  it('is absent by default, written by recordAdOptOutCookie, and read back as opted out', () => {
    expect(hasAdOptOutCookie()).toBe(false);
    recordAdOptOutCookie();
    expect(hasAdOptOutCookie()).toBe(true);
    expect(document.cookie).toContain(`${AD_OPTOUT_COOKIE}=1`);
  });

  it('only the value 1 counts', () => {
    document.cookie = `${AD_OPTOUT_COOKIE}=0; path=/`;
    expect(hasAdOptOutCookie()).toBe(false);
    document.cookie = `${AD_OPTOUT_COOKIE}=yes; path=/`;
    expect(hasAdOptOutCookie()).toBe(false);
  });
});

describe('isAdSharingOptedOut (synchronous: GPC or the cookie)', () => {
  beforeEach(clearCookie);
  afterEach(() => { clearCookie(); vi.unstubAllGlobals(); });

  it('a GPC visitor is opted out AND the cookie is left behind, so the next page and the static stack see it too', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    expect(hasAdOptOutCookie()).toBe(false);
    expect(isAdSharingOptedOut()).toBe(true);
    expect(hasAdOptOutCookie()).toBe(true);
  });

  it('a visitor with the cookie is opted out even without GPC', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: false });
    recordAdOptOutCookie();
    expect(isAdSharingOptedOut()).toBe(true);
  });

  it('a visitor with neither is not opted out and no cookie is written', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: undefined });
    expect(isAdSharingOptedOut()).toBe(false);
    expect(hasAdOptOutCookie()).toBe(false);
  });
});

describe('readStoredOptOut (the signed-in visitor\'s stored flag)', () => {
  beforeEach(clearCookie);
  afterEach(() => { clearCookie(); });

  function fakeSb(over: { user?: { id: string } | null; row?: { ad_sharing_opt_out?: boolean | null } | null; error?: unknown; throws?: boolean } = {}) {
    const selected: string[] = [];
    const eqs: [string, string][] = [];
    const sb: ProfileReader = {
      auth: { getUser: () => (over.throws ? Promise.reject(new Error('down')) : Promise.resolve({ data: { user: over.user === undefined ? { id: 'u1' } : over.user } })) },
      from: (table: string) => {
        selected.push(table);
        return { select: (_c: string) => ({ eq: (c: string, v: string) => { eqs.push([c, v]); return { maybeSingle: () => Promise.resolve({ data: over.row === undefined ? { ad_sharing_opt_out: null } : over.row, error: over.error ?? null }) }; } }) };
      },
    };
    return { sb, selected, eqs };
  }

  it('a profile with ad_sharing_opt_out === true is opted out, reads only the signed-in user\'s own row, and leaves the cookie', async () => {
    const { sb, selected, eqs } = fakeSb({ row: { ad_sharing_opt_out: true } });
    expect(await readStoredOptOut(sb)).toBe(true);
    expect(selected).toEqual(['profiles']);
    expect(eqs).toEqual([['id', 'u1']]);
    expect(hasAdOptOutCookie()).toBe(true);
  });

  it('NULL (never recorded), false, and no profile row without an error are NOT opted out, and no cookie is written', async () => {
    for (const row of [{ ad_sharing_opt_out: null }, { ad_sharing_opt_out: false }, null]) {
      expect(await readStoredOptOut(fakeSb({ row }).sb)).toBe(false);
    }
    expect(hasAdOptOutCookie()).toBe(false);
  });

  it('only the boolean true opts out (a string or number does not)', async () => {
    for (const v of ['true', 1, '1']) {
      expect(await readStoredOptOut(fakeSb({ row: { ad_sharing_opt_out: v as unknown as boolean } }).sb)).toBe(false);
    }
  });

  it("no signed-in user, a failed read, or a thrown error is 'unknown' (the caller treats it as opted out)", async () => {
    expect(await readStoredOptOut(fakeSb({ user: null }).sb)).toBe('unknown');
    expect(await readStoredOptOut(fakeSb({ error: { code: '42703' } }).sb)).toBe('unknown');
    expect(await readStoredOptOut(fakeSb({ throws: true }).sb)).toBe('unknown');
    expect(hasAdOptOutCookie()).toBe(false);
  });
});
