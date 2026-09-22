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
  readReferralIds,
  writeReferralIds,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
  _getCookieMaxAge,
} from '../cookie-storage';
import { seedStaleStorage } from '../../test/storage-fixtures';

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

// ── gh-867: the 7-day hard cap on the session cookie was entirely ours — no
// backend/Supabase requirement forced it (0 of 26,396 session rows carry a
// not_after value). getCookieMaxAge()'s `remaining` argument is always ~3600
// (the 1h access-token lifetime), so `Math.max(remaining, defaultSec)` always
// resolved to `defaultSec` and the outer `Math.max(3600, …)` never bound —
// this function returns exactly `defaultSec` on every call. Raised from 7
// days (604800s) to 400 days (34560000s), Chrome's Max-Age ceiling. ────────
describe('getCookieMaxAge — gh-867 400-day session lifetime', () => {
  const FOUR_HUNDRED_DAYS_SEC = 400 * 24 * 3600;
  const SEVEN_DAYS_SEC = 7 * 24 * 3600;

  it('returns 400 days (not the old 7-day default) when expSec is absent', () => {
    expect(_getCookieMaxAge(null)).toBe(FOUR_HUNDRED_DAYS_SEC);
  });

  it('returns 400 days for a typical ~1h access-token remaining lifetime (the always-hit case)', () => {
    // This is the exact regression the issue describes: `remaining` here is
    // ~3600s (a fresh 1h access token), which must NOT shrink the max-age
    // back down to anything near 7 days.
    expect(_getCookieMaxAge(NOW + 3600)).toBe(FOUR_HUNDRED_DAYS_SEC);
    expect(_getCookieMaxAge(NOW + 3600)).toBeGreaterThan(SEVEN_DAYS_SEC);
  });

  it('never returns less than 400 days, even for an already-expired token', () => {
    expect(_getCookieMaxAge(NOW - 3600)).toBe(FOUR_HUNDRED_DAYS_SEC);
  });
});

// ── gh-2060 NEGATIVE CONTROL — a stale referral key left by a DIFFERENT prior
// visit/write must not survive into a write that does not carry it. Every
// test file in this suite clears storage in beforeEach, which is correct
// default isolation but means no test could previously express "storage
// already has something in it before this test's write runs" — the exact
// precondition this class of bug needs to be observable at all. Uses
// seedStaleStorage (app/test/storage-fixtures.ts) to seed that precondition
// deliberately, on top of (not instead of) the normal clean-slate
// beforeEach below. ──────────────────────────────────────────────────────
describe('writeReferralIds — gh-2060 stale-state contamination (negative control)', () => {
  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
  });

  it('does not let a PRIOR visit\'s agent id leak into a write that omits it', () => {
    // A previous referral visit in this same browser/tab left an agent id
    // behind — e.g. an earlier agent-linked referral click, or a partial
    // write from another code path. Nothing in this test's own setup
    // creates this; it models what an ACTUAL prior visitor already did,
    // which is exactly what the suite-wide beforeEach clear makes
    // unwritable without this fixture.
    seedStaleStorage({
      localStorage: { oq_referral_agent_id: 'AGENT-FROM-A-DIFFERENT-VISIT' },
      sessionStorage: { oq_referral_agent_id: 'AGENT-FROM-A-DIFFERENT-VISIT' },
    });

    // A new, unrelated referral write happens — e.g. auth-callback.tsx
    // "keep the cookie alive" write (app/auth-callback/page.tsx) or a
    // fresh agent-less referral code — that legitimately carries an id
    // and a code but NO agent id.
    writeReferralIds({
      oq_referral_id: 'REFERRAL-NEW',
      oq_referral_code: 'CODE-NEW',
    });

    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('REFERRAL-NEW');
    expect(ids.oq_referral_code).toBe('CODE-NEW');
    // The bug: readReferralIds() falls back per-key to localStorage/
    // sessionStorage when the cookie (fully overwritten by the new write,
    // and so no longer carrying an agent id) doesn't have the key — so the
    // OLD agent id, belonging to a different visit, resurfaces attached to
    // this brand-new referral. That would attribute commission to the
    // wrong partner.
    expect(ids.oq_referral_agent_id).toBeUndefined();
  });

  it('a write that DOES carry an agent id is unaffected (control)', () => {
    writeReferralIds({
      oq_referral_id: 'REFERRAL-1',
      oq_referral_agent_id: 'AGENT-1',
      oq_referral_code: 'CODE-1',
    });
    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('REFERRAL-1');
    expect(ids.oq_referral_agent_id).toBe('AGENT-1');
    expect(ids.oq_referral_code).toBe('CODE-1');
  });
});
