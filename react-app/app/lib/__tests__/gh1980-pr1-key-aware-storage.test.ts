/**
 * gh-1980 PR 1/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") --
 * preparatory storage-adapter factory refactor ahead of PR 2 (storageKey
 * convergence) and PR 3 (flowType: 'pkce' flip).
 *
 * REVIEW: FAIL (PR #2232 comment 5850347173, CTO RUN 42) on the first
 * version of this file: the original tests here only proved a
 * `createOtterQuoteCookieStorage` export exists and that a second call
 * produces a distinct object -- a mutant factory that accepts and discards
 * `storageKey` (`return { ...otterquoteCookieStorage }`) passed every one
 * of them. The key-awareness Marty's #1931 ruling actually required for
 * step 1 -- an auxiliary PKCE `-code-verifier` (or `-user`) key must never
 * read, write, or clear the shared session cookies, so a rejected
 * updateUser()'s PKCE cleanup can't silently sign a user out -- already
 * shipped on `main` for THIS (React) stack via `isAuxiliaryStorageKey()` at
 * commit 88594f4 ("gh-2168: react-app cookie-storage adapter is key-aware
 * (mirror of #2162)"). (Round 1's fix here mis-cited the static stack's
 * commit, `3ced057` -- corrected per round 2, comment 5850607453.) This
 * file's job is now to prove THAT invariant holds for any factory-built
 * instance,
 * regardless of which `storageKey` it was built for -- the discriminating
 * assertions below fail against a mutant where `isAuxiliaryStorageKey`
 * always returns `false` (verified manually; see the PR comment for that
 * run) even though `storageKey` itself is still accepted but unused (that
 * remains true and is reserved for PR 2 -- see cookie-storage.ts's own
 * docstring on `createOtterQuoteCookieStorage`).
 *
 * Fail-first (this file's original form): `createOtterQuoteCookieStorage`
 * does not exist on the pre-PR-1 module -- every assertion below
 * throws/fails on that commit. See the PR/issue comment for the raw
 * pre-fix run of both this file's original and revised forms.
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

describe('gh-1980 PR 1: storage-adapter factory refactor (no behaviour change; key-awareness itself already on main)', () => {
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

  it('a second, independently-keyed instance is a genuinely separate object (structurally distinct from the global singleton, not itself proof of key-aware behavior -- see the key-awareness tests below)', () => {
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

  // REVIEW: FAIL follow-up (comment 5850347173, must-fix 2) -- the actual
  // key-awareness requirement, proven for any factory-built instance
  // regardless of which storageKey it was built for. This is what fails
  // against a mutant `isAuxiliaryStorageKey` that always returns `false`
  // (the pre-gh-2162-round-5 shape) -- Marty's #1931 failure mode is "a
  // signed-in user's PKCE cleanup returns/clears the session blob".
  const PROD_DEFAULT_KEY = 'sb-yeszghaspzwwstvsrioa-auth-token'; // supabase-js's own default for the prod project ref, per a config.js-style client that passes no storageKey
  for (const K of [OTTERQUOTE_AUTH_STORAGE_KEY, PROD_DEFAULT_KEY]) {
    it(`key-awareness (K="${K}"): a code-verifier/-user key never reads the session, and removing it never clears the session cookies`, () => {
      const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'a@example.com' });
      setCookie(_COOKIE_ACCESS, access);
      setCookie(_COOKIE_REFRESH, 'refresh-abc');

      const instance = cookieStorageModule.createOtterQuoteCookieStorage(K);
      const verifierKey = `${K}-code-verifier`;
      const userKey = `${K}-user`;

      // An auxiliary key must never return the session blob, whether or
      // not anything was ever written under it.
      expect(instance.getItem(verifierKey)).toBeNull();
      expect(instance.getItem(userKey)).toBeNull();

      // Removing the code-verifier (supabase-js's PKCE cleanup on ANY
      // rejected updateUser(), per gh-2154 P-1) must NOT sign the user out:
      // the shared session cookies and the session itself must survive.
      instance.removeItem(verifierKey);
      expect(document.cookie).toContain(`${_COOKIE_ACCESS}=`);
      expect(document.cookie).toContain(`${_COOKIE_REFRESH}=`);
      expect(instance.getItem(K)).not.toBeNull();
    });
  }
});
