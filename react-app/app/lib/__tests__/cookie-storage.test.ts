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
