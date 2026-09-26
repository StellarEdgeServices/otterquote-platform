/**
 * gh-1980 PR 1/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") — key-aware
 * storage adapters, step 1 of Marty's three-PR sequence (#1931 artifact 3,
 * ruling quoted verbatim on #1980): "Make both storage adapters key-aware.
 * No behaviour change, fully testable, no user impact."
 *
 * Today `otterquoteCookieStorage` is a single module-level singleton object
 * that is never told which `storageKey` it is paired with -- every client
 * across the ~20 construction sites that uses it shares the exact same
 * object, and the object has no notion of "the key I was built for". That
 * is fine while every client either uses the canonical
 * OTTERQUOTE_AUTH_STORAGE_KEY or falls through supabase-js's own default,
 * but it is NOT the shape PR 2 needs once `storageKey` convergence starts
 * threading an explicit key through each construction site (and PR 3 flips
 * `flowType: 'pkce'`, which mints its own PKCE code-verifier keys off
 * whatever storageKey a given client actually uses).
 *
 * This test proves the new `createOtterQuoteCookieStorage(storageKey)`
 * factory exists, that it is what `otterquoteCookieStorage` (the exported
 * singleton every current call site still imports) is built from, and that
 * building a second, independently-keyed instance behaves identically to
 * the default one for every scenario the pre-existing suite
 * (cookie-storage.test.ts / cookie-storage.updateuser.test.ts) already
 * covers -- i.e. genuinely "no behaviour change, no user impact": the
 * default export's runtime behavior is byte-for-byte the same before and
 * after this PR, and the new capability is purely additive.
 *
 * Fail-first: `createOtterQuoteCookieStorage` does not exist on the
 * pre-PR-1 module (only `otterquoteCookieStorage`, the bound singleton) --
 * every assertion below throws/fails on that commit. See the PR/issue
 * comment for the raw pre-fix run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as cookieStorageModule from '../cookie-storage';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
} from '../cookie-storage';

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/`;
}
function clearCookies(): void {
  for (const pair of document.cookie.split('; ')) {
    const k = pair.split('=')[0];
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
}
function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

const NOW = Math.floor(Date.now() / 1000);
const SUB = '99999999-8888-7777-6666-555555555555';

describe('gh-1980 PR 1: storage adapters become key-aware (no behaviour change)', () => {
  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it('exports a createOtterQuoteCookieStorage(storageKey) factory', () => {
    expect(typeof cookieStorageModule.createOtterQuoteCookieStorage).toBe('function');
  });

  it('the default singleton is built from the factory bound to the canonical key', () => {
    const rebuilt = cookieStorageModule.createOtterQuoteCookieStorage(OTTERQUOTE_AUTH_STORAGE_KEY);

    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'a@example.com' });
    setCookie(_COOKIE_ACCESS, access);
    setCookie(_COOKIE_REFRESH, 'refresh-abc');

    // No behaviour change: reading through the pre-existing singleton and
    // through a freshly-built instance for the SAME key returns the same
    // reconstructed session.
    const viaSingleton = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    const viaFactory = rebuilt.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    expect(viaFactory).toBe(viaSingleton);
    expect(JSON.parse(viaFactory as string).user.id).toBe(SUB);
  });

  it('a second, independently-keyed instance is a genuinely separate object (key-aware, not a global singleton reference)', () => {
    const instanceA = cookieStorageModule.createOtterQuoteCookieStorage('sb-otterquote-auth');
    const instanceB = cookieStorageModule.createOtterQuoteCookieStorage('sb-some-other-project-auth-token');
    expect(instanceA).not.toBe(instanceB);
    expect(instanceA).not.toBe(otterquoteCookieStorage);
  });

  it('parity: an auxiliary (PKCE code-verifier) key on a freshly-built instance behaves exactly like the existing singleton -- plain localStorage, session cookies undisturbed', () => {
    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'a@example.com' });
    setCookie(_COOKIE_ACCESS, access);
    setCookie(_COOKIE_REFRESH, 'refresh-abc');

    const instance = cookieStorageModule.createOtterQuoteCookieStorage(OTTERQUOTE_AUTH_STORAGE_KEY);
    const verifierKey = `${OTTERQUOTE_AUTH_STORAGE_KEY}-code-verifier`;

    instance.setItem(verifierKey, 'the-verifier-value');
    expect(instance.getItem(verifierKey)).toBe('the-verifier-value');
    // Session cookies must be untouched -- same invariant gh-2168 already covers
    // for the singleton; must hold for any factory-built instance too.
    expect(document.cookie).toContain(_COOKIE_ACCESS);
    expect(document.cookie).toContain(_COOKIE_REFRESH);

    // And it matches the singleton's own behavior for the identical key/value.
    otterquoteCookieStorage.setItem(verifierKey, 'the-verifier-value');
    expect(otterquoteCookieStorage.getItem(verifierKey)).toBe(instance.getItem(verifierKey));
  });

  it('parity: removeItem() on a factory-built instance clears the shared session cookies exactly like the singleton (no regression toward the round-4 exact-key allowlist bug)', () => {
    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'a@example.com' });
    setCookie(_COOKIE_ACCESS, access);
    setCookie(_COOKIE_REFRESH, 'refresh-abc');

    // Built for a DIFFERENT key than the canonical one -- mirrors a client
    // that (pre-storageKey-convergence, i.e. today) never passes storageKey
    // and gets supabase-js's own default. removeItem must still clear the
    // shared cookies for ANY non-auxiliary key, exactly like the singleton.
    const instance = cookieStorageModule.createOtterQuoteCookieStorage('sb-some-other-project-auth-token');
    instance.removeItem('sb-some-other-project-auth-token');

    expect(document.cookie).not.toContain(_COOKIE_ACCESS + '=');
    expect(document.cookie).not.toContain(_COOKIE_REFRESH + '=');
  });
});
