/**
 * gh-1983 — first-touch ad attribution: core parsing + browser capture/record.
 * Every positive case sits beside a negative control (untagged URL -> nothing).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseFirstTouch,
  deserializeFirstTouch,
  buildFirstTouchCookie,
  firstTouchSetCookie,
  hasTrackedKey,
  readCookieValue,
  cleanValue,
  FT_COOKIE,
  withFirstTouchParam,
  decodeFirstTouchParam,
  encodeFirstTouchParam,
} from '../attribution-core';
import { captureFirstTouch, readFirstTouch, recordFirstTouch, adoptFirstTouchFromParam } from '../attribution';

const NOW = new Date('2026-09-16T03:00:00.000Z');

describe('attribution-core parseFirstTouch', () => {
  it('captures utm_* + fbclid + gclid, path and referrer host only', () => {
    const ft = parseFirstTouch(
      'https://app.otterquote.com/get-started?utm_source=fb&utm_medium=paid&utm_campaign=test&utm_content=c1&utm_term=roof&fbclid=x&gclid=g#access_token=secret',
      'https://lm.facebook.com/l.php?u=https%3A%2F%2Fapp.otterquote.com',
      NOW,
    );
    expect(ft).toEqual({
      v: 1,
      ts: '2026-09-16T03:00:00.000Z',
      utm_source: 'fb',
      utm_medium: 'paid',
      utm_campaign: 'test',
      utm_content: 'c1',
      utm_term: 'roof',
      fbclid: 'x',
      gclid: 'g',
      landing_path: '/get-started',
      referrer: 'lm.facebook.com',
    });
    expect(JSON.stringify(ft)).not.toContain('secret');
  });

  it('gh-3002 NEGATIVE CONTROL: a page load with no query string still yields a landing path', () => {
    const ft = parseFirstTouch('https://app.otterquote.com/get-started', null, NOW)!;
    expect(ft).toEqual({ v: 1, ts: NOW.toISOString(), landing_path: '/get-started' });
    expect(hasTrackedKey(ft)).toBe(false);
  });

  it('gh-3002: untagged params (track=, ref=, empty utm) are not tracked keys but keep path + referrer host', () => {
    const ft = parseFirstTouch('https://app.otterquote.com/get-started?track=insurance&ref=abc', 'https://www.google.com/search?q=x', NOW)!;
    expect(ft).toEqual({ v: 1, ts: NOW.toISOString(), landing_path: '/get-started', referrer: 'www.google.com' });
    expect(hasTrackedKey(ft)).toBe(false);
    expect(hasTrackedKey(parseFirstTouch('https://app.otterquote.com/?utm_source=%20%20', null, NOW))).toBe(false);
  });

  it('an unparseable URL -> null', () => {
    expect(parseFirstTouch('not a url', null, NOW)).toBeNull();
  });

  it('keeps a long click id whole (fbclid/gclid cap 1000) but caps utm values at 200', () => {
    const long = 'IwY2' + 'a'.repeat(400);
    const ft = parseFirstTouch(`https://otterquote.com/?fbclid=${long}&utm_campaign=${'c'.repeat(400)}`, null, NOW)!;
    expect(ft.fbclid).toBe(long);
    expect(ft.utm_campaign).toHaveLength(200);
    expect(deserializeFirstTouch(JSON.stringify(ft))?.fbclid).toBe(long);
  });

  it('strips non-printable characters and caps length', () => {
    expect(cleanValue('  abéc  ')).toBe('abc');
    expect(cleanValue('z'.repeat(500))).toHaveLength(200);
    expect(cleanValue(42)).toBeUndefined();
  });
});

describe('attribution-core cookie round trip', () => {
  it('builds a .otterquote.com cookie that deserializes back', () => {
    const ft = parseFirstTouch('https://otterquote.com/?utm_source=fb&fbclid=x', null, NOW)!;
    const c = buildFirstTouchCookie(ft, 'otterquote.com', true)!;
    expect(c).toMatch(/^oq_ft=/);
    expect(c).toContain('; Domain=.otterquote.com');
    expect(c).toContain('; Max-Age=7776000');
    expect(c).toContain('; SameSite=Lax');
    expect(c).toContain('; Secure');
    const back = deserializeFirstTouch(readCookieValue(c.split(';')[0], FT_COOKIE));
    expect(back).toEqual(ft);
  });

  it('localhost / previews get a host-only cookie', () => {
    const ft = parseFirstTouch('http://localhost:3000/?gclid=g', null, NOW)!;
    const c = buildFirstTouchCookie(ft, 'localhost', false)!;
    expect(c).not.toContain('Domain=');
    expect(c).not.toContain('Secure');
  });

  it('deserialize rejects junk, arrays, missing ts, and objects with neither a tracked key nor a path', () => {
    expect(deserializeFirstTouch('{bad')).toBeNull();
    expect(deserializeFirstTouch('[]')).toBeNull();
    expect(deserializeFirstTouch(JSON.stringify({ utm_source: 'fb' }))).toBeNull();
    expect(deserializeFirstTouch(JSON.stringify({ ts: NOW.toISOString() }))).toBeNull();
    expect(deserializeFirstTouch(JSON.stringify({ ts: NOW.toISOString(), referrer: 'google.com' }))).toBeNull();
    // gh-3002: an organic record (landing path only) is valid.
    expect(deserializeFirstTouch(JSON.stringify({ ts: NOW.toISOString(), landing_path: '/' }))).toEqual({
      v: 1, ts: NOW.toISOString(), landing_path: '/',
    });
  });

  it('firstTouchSetCookie: tagged + no cookie -> cookie; stored tagged touch -> null', () => {
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started?utm_source=fb', null, null, NOW)).toMatch(/^oq_ft=/);
    const stored = `oq_ft=${encodeURIComponent(JSON.stringify({ v: 1, utm_source: 'youtube', ts: NOW.toISOString() }))}`;
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started?utm_source=fb', stored, null, NOW)).toBeNull();
  });

  it('gh-3002 firstTouchSetCookie: untagged page navigation -> cookie; non-page or missing Accept -> null', () => {
    const c = firstTouchSetCookie('https://app.otterquote.com/get-started', null, 'https://www.google.com/', NOW, { accept: 'text/html,application/xhtml+xml' });
    expect(c).toMatch(/^oq_ft=/);
    const back = deserializeFirstTouch(readCookieValue(c!.split(';')[0], FT_COOKIE));
    expect(back).toEqual({ v: 1, ts: NOW.toISOString(), landing_path: '/get-started', referrer: 'www.google.com' });
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started', null, null, NOW, { accept: 'application/json' })).toBeNull();
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started', null, null, NOW)).toBeNull();
  });

  const HTML = 'text/html';
  const URL0 = 'https://app.otterquote.com/get-started';

  it('gh-3002 GPC: Sec-GPC: 1 suppresses UNTAGGED capture; Sec-GPC: 0 / absent does not', () => {
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML, gpc: '1' })).toBeNull();
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML, gpc: '0' })).toMatch(/^oq_ft=/);
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML })).toMatch(/^oq_ft=/);
  });

  it('gh-3002 opt-out cookie: oq_ad_optout=1 suppresses UNTAGGED capture; other values do not', () => {
    expect(firstTouchSetCookie(URL0, 'a=b; oq_ad_optout=1', null, NOW, { accept: HTML })).toBeNull();
    expect(firstTouchSetCookie(URL0, 'oq_ad_optout=0', null, NOW, { accept: HTML })).toMatch(/^oq_ft=/);
  });

  it('gh-3002 GPC / opt-out do not change TAGGED capture (unchanged from #1983)', () => {
    expect(firstTouchSetCookie(URL0 + '?utm_source=fb', null, null, NOW, { gpc: '1' })).toMatch(/^oq_ft=/);
    expect(firstTouchSetCookie(URL0 + '?gclid=g', 'oq_ad_optout=1', null, NOW)).toMatch(/^oq_ft=/);
  });

  it('gh-3002: prefetch and crawler requests never mint an UNTAGGED touch', () => {
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML, purpose: 'prefetch' })).toBeNull();
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML, userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toBeNull();
    expect(firstTouchSetCookie(URL0, null, null, NOW, { accept: HTML, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' })).toMatch(/^oq_ft=/);
  });

  it('gh-3002: a stored first touch is NEVER replaced, tagged or not (first_touch_at preserved)', () => {
    const organic = `oq_ft=${encodeURIComponent(JSON.stringify({ v: 1, landing_path: '/', ts: NOW.toISOString() }))}`;
    expect(firstTouchSetCookie('https://otterquote.com/?utm_source=fb', organic, null, NOW, { accept: HTML })).toBeNull();
    expect(firstTouchSetCookie('https://otterquote.com/faq', organic, null, NOW, { accept: HTML })).toBeNull();
  });
});

function clearFirstTouch() {
  document.cookie = 'oq_ft=; Path=/; Max-Age=0';
  localStorage.clear();
}

describe('attribution browser capture', () => {
  beforeEach(() => {
    clearFirstTouch();
    window.history.replaceState({}, '', '/');
  });

  it('stores a tagged landing in localStorage and cookie', () => {
    window.history.replaceState({}, '', '/get-started?utm_source=fb&utm_campaign=test&fbclid=x');
    const ft = captureFirstTouch();
    expect(ft?.utm_source).toBe('fb');
    expect(JSON.parse(localStorage.getItem('oq_ft')!).fbclid).toBe('x');
    expect(document.cookie).toContain('oq_ft=');
    expect(readFirstTouch()?.utm_campaign).toBe('test');
  });

  it('gh-3002 NEGATIVE CONTROL: an untagged landing (no query string) stores its landing path', () => {
    window.history.replaceState({}, '', '/get-started');
    const ft = captureFirstTouch();
    expect(ft?.landing_path).toBe('/get-started');
    expect(ft?.utm_source).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('oq_ft')!).landing_path).toBe('/get-started');
    expect(readFirstTouch()?.landing_path).toBe('/get-started');
  });

  it('first tagged touch wins over a later tagged landing', () => {
    window.history.replaceState({}, '', '/?utm_source=youtube');
    captureFirstTouch();
    window.history.replaceState({}, '', '/get-started?utm_source=fb&fbclid=late');
    expect(captureFirstTouch()?.utm_source).toBe('youtube');
    expect(readFirstTouch()?.fbclid).toBeUndefined();
  });

  it('gh-3002: the first untagged landing wins over a later untagged page', () => {
    window.history.replaceState({}, '', '/');
    captureFirstTouch();
    window.history.replaceState({}, '', '/get-started');
    expect(captureFirstTouch()?.landing_path).toBe('/');
  });

  it('gh-3002: an untagged first touch is NOT replaced by a later tagged landing (first_touch_at and landing_path preserved)', () => {
    window.history.replaceState({}, '', '/');
    const first = captureFirstTouch()!;
    window.history.replaceState({}, '', '/get-started?utm_source=fb&fbclid=ad');
    const ft = captureFirstTouch()!;
    expect(ft.utm_source).toBeUndefined();
    expect(ft.landing_path).toBe('/');
    expect(ft.ts).toBe(first.ts);
    expect(JSON.parse(localStorage.getItem('oq_ft')!).fbclid).toBeUndefined();
  });

  it('gh-3002 GPC: navigator.globalPrivacyControl === true stores no UNTAGGED touch, but still stores a tagged one', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    try {
      window.history.replaceState({}, '', '/get-started');
      expect(captureFirstTouch()).toBeNull();
      expect(localStorage.getItem('oq_ft')).toBeNull();
      window.history.replaceState({}, '', '/get-started?utm_source=fb');
      expect(captureFirstTouch()?.utm_source).toBe('fb');
    } finally {
      delete (navigator as unknown as Record<string, unknown>).globalPrivacyControl;
    }
  });

  it('gh-3002 opt-out cookie: oq_ad_optout=1 stores no UNTAGGED touch', () => {
    document.cookie = 'oq_ad_optout=1; Path=/';
    try {
      window.history.replaceState({}, '', '/get-started');
      expect(captureFirstTouch()).toBeNull();
      expect(localStorage.getItem('oq_ft')).toBeNull();
    } finally {
      document.cookie = 'oq_ad_optout=; Path=/; Max-Age=0';
    }
  });

  it('heals localStorage from a server-set cookie', () => {
    document.cookie = `oq_ft=${encodeURIComponent(JSON.stringify({ v: 1, gclid: 'g1', ts: NOW.toISOString() }))}; Path=/`;
    window.history.replaceState({}, '', '/get-started');
    expect(captureFirstTouch()?.gclid).toBe('g1');
    expect(JSON.parse(localStorage.getItem('oq_ft')!).gclid).toBe('g1');
  });
});

describe('recordFirstTouch', () => {
  beforeEach(() => clearFirstTouch());

  it('sends the stored touch to the RPC', async () => {
    window.history.replaceState({}, '', '/?utm_source=fb');
    captureFirstTouch();
    const rpc = vi.fn().mockResolvedValue({ data: { recorded: true }, error: null });
    await expect(recordFirstTouch({ rpc })).resolves.toEqual({ recorded: true });
    expect(rpc).toHaveBeenCalledWith('record_first_touch_attribution', {
      p_attr: expect.objectContaining({ utm_source: 'fb' }),
    });
  });

  it('sends p_attr null when nothing is stored (server falls back to user_metadata)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { recorded: false }, error: null });
    await recordFirstTouch({ rpc });
    expect(rpc).toHaveBeenCalledWith('record_first_touch_attribution', { p_attr: null });
  });

  it('never rejects: RPC error, thrown error, and a hung RPC all resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordFirstTouch({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }) })).resolves.toBeNull();
    await expect(recordFirstTouch({ rpc: vi.fn().mockRejectedValue(new Error('boom')) })).resolves.toBeNull();
    await expect(recordFirstTouch({ rpc: () => new Promise(() => {}) }, 20)).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('OAuth browser-switch carry (?ft= on redirectTo)', () => {
  const ft = parseFirstTouch('https://app.otterquote.com/get-started?utm_source=fb&utm_campaign=test&fbclid=' + 'x'.repeat(500), null, NOW)!;

  beforeEach(() => clearFirstTouch());

  it('round-trips through withFirstTouchParam / decodeFirstTouchParam and keeps intent', () => {
    const url = withFirstTouchParam('https://app.otterquote.com/auth-callback?intent=homeowner', ft);
    const u = new URL(url);
    expect(u.searchParams.get('intent')).toBe('homeowner');
    expect(decodeFirstTouchParam(u.searchParams.get('ft'))).toEqual(ft);
  });

  it('sheds optional fields, then drops ft entirely, to keep redirectTo <= 1500-char ft', () => {
    const big = parseFirstTouch(
      'https://app.otterquote.com/get-started?utm_source=fb&utm_term=' + 't'.repeat(200) + '&utm_content=' + 'c'.repeat(200) + '&fbclid=' + 'f'.repeat(700),
      null, NOW,
    )!;
    const slimmed = decodeFirstTouchParam(new URL(withFirstTouchParam('https://app.otterquote.com/auth-callback', big)).searchParams.get('ft'));
    expect(slimmed?.fbclid).toBe(big.fbclid);
    expect(slimmed?.utm_term).toBeUndefined();
    const huge = { ...big, gclid: 'g'.repeat(1000), fbclid: 'f'.repeat(1000) };
    expect(withFirstTouchParam('https://app.otterquote.com/auth-callback?intent=homeowner', huge)).toBe(
      'https://app.otterquote.com/auth-callback?intent=homeowner',
    );
  });

  it('NEGATIVE CONTROL: no touch -> redirect URL unchanged; junk ft -> null', () => {
    expect(withFirstTouchParam('https://app.otterquote.com/auth-callback?intent=homeowner', null)).toBe(
      'https://app.otterquote.com/auth-callback?intent=homeowner',
    );
    expect(decodeFirstTouchParam('%%%')).toBeNull();
    expect(decodeFirstTouchParam(btoa('{"utm_source":"fb"}'))).toBeNull();
    expect(decodeFirstTouchParam(null)).toBeNull();
  });

  it('adopts the param into an empty browser (the Safari side of the hand-off)', () => {
    const adopted = adoptFirstTouchFromParam(encodeFirstTouchParam(ft));
    expect(adopted?.utm_campaign).toBe('test');
    expect(readFirstTouch()?.fbclid).toBe(ft.fbclid);
  });

  it('never overrides a touch already stored in this browser', () => {
    window.history.replaceState({}, '', '/?utm_source=youtube');
    captureFirstTouch();
    expect(adoptFirstTouchFromParam(encodeFirstTouchParam(ft))?.utm_source).toBe('youtube');
  });

  it('gh-3002: an UNTAGGED ?ft= is not adopted when this browser has GPC or oq_ad_optout=1; a tagged one still is', () => {
    const organic = parseFirstTouch('https://otterquote.com/faq', 'https://www.google.com/', NOW)!;
    const enc = encodeFirstTouchParam(organic);
    expect(adoptFirstTouchFromParam(enc)?.landing_path).toBe('/faq'); // control: not opted out -> adopted
    clearFirstTouch();
    document.cookie = 'oq_ad_optout=1; Path=/';
    try {
      expect(adoptFirstTouchFromParam(enc)).toBeNull();
      expect(localStorage.getItem('oq_ft')).toBeNull();
      expect(adoptFirstTouchFromParam(encodeFirstTouchParam(ft))?.utm_campaign).toBe('test');
    } finally {
      document.cookie = 'oq_ad_optout=; Path=/; Max-Age=0';
    }
    clearFirstTouch();
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    try {
      expect(adoptFirstTouchFromParam(enc)).toBeNull();
      expect(localStorage.getItem('oq_ft')).toBeNull();
    } finally {
      delete (navigator as unknown as Record<string, unknown>).globalPrivacyControl;
    }
  });
});
