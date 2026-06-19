/**
 * Parity tests for cookie-storage.ts reconstructSession() — D-211 foundation (F-1).
 *
 * Proves the React cookie-storage adapter hydrates `user` from the access-token
 * JWT claims on read, matching the static js/cookie-storage.js behavior (the
 * D-212 fix, May 13 2026). Before this fix the TS port returned user:null, so
 * cross-subdomain SSO into the React app and warm reloads from cookies were
 * treated as logged-out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
  readValidCookieSession,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
} from '../cookie-storage';

// Build an unsigned JWT (header.payload.signature) with base64url segments.
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

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/`;
}
function clearCookies(): void {
  for (const pair of document.cookie.split('; ')) {
    const k = pair.split('=')[0];
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
}

const NOW = Math.floor(Date.now() / 1000);
const SUB = '11111111-2222-3333-4444-555555555555';
const EMAIL = 'contractor@example.com';

describe('cookie-storage reconstructSession (via getItem) — D-212 user hydration', () => {
  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it('hydrates user from JWT claims when both cookies are present', () => {
    const access = makeJwt({
      sub: SUB,
      email: EMAIL,
      exp: NOW + 3600,
      iat: NOW,
      aud: 'authenticated',
      role: 'authenticated',
      email_verified: true,
    });
    setCookie(_COOKIE_ACCESS, access);
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');

    const raw = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const session = JSON.parse(raw as string);

    // Core regression guard: user must NOT be null (the F-1 fix).
    expect(session.user).not.toBeNull();
    expect(session.user.id).toBe(SUB);
    expect(session.user.email).toBe(EMAIL);
    expect(session.user.aud).toBe('authenticated');
    expect(session.user.role).toBe('authenticated');
    expect(session.access_token).toBe(access);
    expect(session.refresh_token).toBe('refresh-token-abc');
    expect(session.expires_at).toBe(NOW + 3600);
    expect(session.token_type).toBe('bearer');
  });

  it('returns null (no session) when cookies are absent', () => {
    expect(otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('preserves tokens but leaves user null for a structurally invalid access token', () => {
    setCookie(_COOKIE_ACCESS, 'not-a-jwt');
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
    const raw = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    const session = JSON.parse(raw as string);
    expect(session.user).toBeNull();
    expect(session.access_token).toBe('not-a-jwt');
  });
});

// ── D-212 session-precedence: a valid shared cookie must win over a stale, expired,
// or cross-user per-origin localStorage value, and rehydrate that copy. ──────────
describe('cookie-storage getItem precedence + hydration — D-212 session-precedence', () => {
  const COOKIE_SUB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OTHER_SUB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  function setValidCookie(sub: string = COOKIE_SUB): void {
    setCookie(_COOKIE_ACCESS, makeJwt({ sub, email: EMAIL, exp: NOW + 3600, iat: NOW, email_verified: true }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
  }
  function seedLocalStorage(accessJwt: string): void {
    window.localStorage.setItem(
      OTTERQUOTE_AUTH_STORAGE_KEY,
      JSON.stringify({ access_token: accessJwt, refresh_token: 'seed-rt' }),
    );
  }

  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it('(a) returns the cookie session — not a stale/expired same-user localStorage value — and rehydrates localStorage', () => {
    // A 30-day-old expired session left in this origin's localStorage by a prior login.
    seedLocalStorage(makeJwt({ sub: COOKIE_SUB, exp: NOW - 30 * 24 * 3600, iat: NOW - 31 * 24 * 3600 }));
    setValidCookie();

    const raw = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY) as string;
    const session = JSON.parse(raw);
    expect(session.user.id).toBe(COOKIE_SUB);
    expect(session.expires_at).toBe(NOW + 3600); // the fresh cookie exp, not the stale one
    // The stale localStorage copy is overwritten with the cookie session.
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBe(raw);
  });

  it('(b) reconstructs from the cookie and hydrates an EMPTY localStorage', () => {
    setValidCookie();
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBeNull();

    const raw = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY) as string;
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw).user.id).toBe(COOKIE_SUB);
    // First app-origin read hydrates localStorage from the cookie.
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBe(raw);
  });

  it('(c) a cross-user localStorage value (sub ≠ cookie sub) does NOT shadow the cookie; cookie wins', () => {
    // A different user's still-valid session sitting in this origin's localStorage.
    seedLocalStorage(makeJwt({ sub: OTHER_SUB, exp: NOW + 3600, iat: NOW }));
    setValidCookie(COOKIE_SUB);

    const raw = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY) as string;
    const session = JSON.parse(raw);
    expect(session.user.id).toBe(COOKIE_SUB);
    expect(session.user.id).not.toBe(OTHER_SUB);
    // localStorage rehydrated to the cookie user — the cross-user value cannot resurface.
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBe(raw);
  });

  it('does NOT needlessly rewrite a same-user, non-expired localStorage copy', () => {
    // Same user + fresh exp, but a distinct payload (extra field) — must be preserved.
    window.localStorage.setItem(
      OTTERQUOTE_AUTH_STORAGE_KEY,
      JSON.stringify({ access_token: makeJwt({ sub: COOKIE_SUB, exp: NOW + 3600, iat: NOW }), refresh_token: 'seed-rt', keep: 'me' }),
    );
    setValidCookie(COOKIE_SUB);

    otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    // The fresh same-user copy is left untouched (no churn).
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toContain('"keep":"me"');
  });
});

describe('readValidCookieSession — fail-safe cookie recovery (D-212)', () => {
  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it('returns the reconstructed session for a valid, non-expired cookie', () => {
    setCookie(_COOKIE_ACCESS, makeJwt({ sub: SUB, email: EMAIL, exp: NOW + 3600, iat: NOW }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
    const session = readValidCookieSession();
    expect(session).not.toBeNull();
    expect(session?.user?.id).toBe(SUB);
    expect(session?.expires_at).toBe(NOW + 3600);
  });

  it('returns null when no cookie is present', () => {
    expect(readValidCookieSession()).toBeNull();
  });

  it("returns null for an EXPIRED cookie access token (refresh is supabase-js's job)", () => {
    setCookie(_COOKIE_ACCESS, makeJwt({ sub: SUB, exp: NOW - 60, iat: NOW - 3660 }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
    expect(readValidCookieSession()).toBeNull();
  });

  it('returns null for a structurally invalid access token (no user hydrated)', () => {
    setCookie(_COOKIE_ACCESS, 'not-a-jwt');
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
    expect(readValidCookieSession()).toBeNull();
  });
});
