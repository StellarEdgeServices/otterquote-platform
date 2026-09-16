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
  readCookieValue,
  cleanValue,
  FT_COOKIE,
} from '../attribution-core';
import { captureFirstTouch, readFirstTouch, recordFirstTouch, isMetaInAppBrowser, retagUrlForInAppBrowser } from '../attribution';

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

  it('NEGATIVE CONTROL: no tracked key -> null (track=, ref=, empty utm)', () => {
    expect(parseFirstTouch('https://app.otterquote.com/get-started', null, NOW)).toBeNull();
    expect(parseFirstTouch('https://app.otterquote.com/get-started?track=insurance&ref=abc', 'https://google.com', NOW)).toBeNull();
    expect(parseFirstTouch('https://app.otterquote.com/?utm_source=%20%20', null, NOW)).toBeNull();
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

  it('deserialize rejects junk, arrays, missing ts, and untagged objects', () => {
    expect(deserializeFirstTouch('{bad')).toBeNull();
    expect(deserializeFirstTouch('[]')).toBeNull();
    expect(deserializeFirstTouch(JSON.stringify({ utm_source: 'fb' }))).toBeNull();
    expect(deserializeFirstTouch(JSON.stringify({ ts: NOW.toISOString(), landing_path: '/' }))).toBeNull();
  });

  it('firstTouchSetCookie: tagged + no cookie -> cookie; stored touch -> null; untagged -> null', () => {
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started?utm_source=fb', null, null, NOW)).toMatch(/^oq_ft=/);
    const stored = `oq_ft=${encodeURIComponent(JSON.stringify({ v: 1, utm_source: 'youtube', ts: NOW.toISOString() }))}`;
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started?utm_source=fb', stored, null, NOW)).toBeNull();
    expect(firstTouchSetCookie('https://app.otterquote.com/get-started', null, null, NOW)).toBeNull();
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

  it('NEGATIVE CONTROL: an untagged landing stores nothing', () => {
    window.history.replaceState({}, '', '/get-started');
    expect(captureFirstTouch()).toBeNull();
    expect(localStorage.getItem('oq_ft')).toBeNull();
    expect(readFirstTouch()).toBeNull();
  });

  it('first tagged touch wins over a later tagged landing', () => {
    window.history.replaceState({}, '', '/?utm_source=youtube');
    captureFirstTouch();
    window.history.replaceState({}, '', '/get-started?utm_source=fb&fbclid=late');
    expect(captureFirstTouch()?.utm_source).toBe('youtube');
    expect(readFirstTouch()?.fbclid).toBeUndefined();
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

describe('Meta in-app browser URL re-tag (OAuth hand-off to Safari/Chrome)', () => {
  const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]';
  const stored = { v: 1 as const, utm_source: 'fb', utm_campaign: 'test', fbclid: 'x', ts: NOW.toISOString() };

  beforeEach(() => {
    clearFirstTouch();
    vi.restoreAllMocks();
  });

  it('detects FB/Instagram user agents and not ordinary Safari', () => {
    expect(isMetaInAppBrowser(FB_UA)).toBe(true);
    expect(isMetaInAppBrowser('Mozilla/5.0 (iPhone) Instagram 300.0')).toBe(true);
    expect(isMetaInAppBrowser('Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/604.1')).toBe(false);
  });

  it('puts stored params back on an untagged /get-started inside the FB in-app browser', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(FB_UA);
    window.history.replaceState({}, '', '/get-started?track=insurance');
    expect(retagUrlForInAppBrowser(stored)).toBe(true);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('utm_source')).toBe('fb');
    expect(url.searchParams.get('fbclid')).toBe('x');
    expect(url.searchParams.get('track')).toBe('insurance');
  });

  it('NEGATIVE CONTROL: no re-tag in a normal browser, off /get-started, or when already tagged', () => {
    window.history.replaceState({}, '', '/get-started');
    expect(retagUrlForInAppBrowser(stored)).toBe(false);
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(FB_UA);
    window.history.replaceState({}, '', '/trade-selector');
    expect(retagUrlForInAppBrowser(stored)).toBe(false);
    window.history.replaceState({}, '', '/get-started?gclid=g');
    expect(retagUrlForInAppBrowser(stored)).toBe(false);
    expect(new URL(window.location.href).searchParams.get('fbclid')).toBeNull();
  });
});
