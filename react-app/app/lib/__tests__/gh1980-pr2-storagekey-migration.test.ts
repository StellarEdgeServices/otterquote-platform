/**
 * gh-1980 PR 2/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") --
 * storageKey convergence + migration safety.
 *
 * PR 2's job: converge every browser-side Supabase client construction onto
 * the canonical storageKey (OTTERQUOTE_AUTH_STORAGE_KEY), and pin
 * supabase-js so the version does not float. The React stack's own client
 * (app/lib/supabase.ts) already used the canonical key before this PR --
 * this file's job is (a) to pin that fact down so it cannot silently drift,
 * and (b) to prove the migration-safety guarantee PR 2 adds to
 * cookie-storage.ts's getItem(): a session that exists only under a legacy
 * (pre-convergence) storage key must NOT be treated as signed-out the first
 * time a call site converges onto the canonical key. That guarantee is what
 * makes it safe for the several static-stack pages (admin-dashboard.html,
 * admin-homeowners.html, admin-measurements.html, and the `window.sb ||
 * createClient(...)` fallback sites) to switch, in this same PR, from
 * supabase-js's own default storage/key to this adapter under the
 * canonical key without signing anyone out.
 *
 * #488 regression coverage (RETURNED per REVIEW: FAIL comment 5856934888 /
 * RETURNED 5856979533 on PR #2255, CTO RUN 43): the original
 * migrateLegacySession() ran before the "both cookies absent -> signed out,
 * purge local copies" branch and wrote a still-valid per-origin localStorage
 * session back onto the shared, domain-wide cookies -- reversing #488. A
 * user who signs out on app.otterquote.com (deleting only the shared
 * cookies + app's own localStorage) and then loads otterquote.com was
 * signed back in, because otterquote.com's own localStorage copy (canonical
 * key OR any recognized legacy key) still had a live session and got
 * promoted onto the cookies. migrateLegacySession() has been removed
 * entirely; getItem() now runs the unconditional #488 purge exactly as it
 * did before this PR, regardless of which key (canonical or legacy) carries
 * the leftover session. The tests below fail against PR #2255 head
 * 50ef0f81 and pass on this head.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
  createOtterQuoteCookieStorage,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
} from '../cookie-storage';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
function sessionJson(accessToken: string, refreshToken: string, expSec: number): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expSec,
    expires_in: expSec - Math.floor(Date.now() / 1000),
    token_type: 'bearer',
    user: null,
  });
}

const NOW = Math.floor(Date.now() / 1000);
const SUB = '77777777-6666-5555-4444-333333333333';
// 'sb_at' is cookie-storage.ts's own always-present LEGACY_KEYS entry
// ("React stack pre-fix key") -- used here rather than the env-derived
// `sb-<project-ref>-auth-token` pattern because LEGACY_KEYS is computed once
// from process.env.NEXT_PUBLIC_SUPABASE_URL at module load time, before any
// per-test env stubbing could take effect. The migration code path exercised
// is identical either way -- see js/cookie-storage.js's legacyKeys(), which
// pattern-scans localStorage directly instead of env-deriving and so is not
// subject to this same test-environment constraint.
const LEGACY_KEY = 'sb_at';

describe('gh-1980 PR 2: React client already converged onto the canonical storageKey', () => {
  it('app/lib/supabase.ts wires storageKey to the imported OTTERQUOTE_AUTH_STORAGE_KEY constant, not a hardcoded literal', () => {
    // Static-source check rather than importing ../supabase.ts directly: that
    // module throws at import time unless NEXT_PUBLIC_SUPABASE_URL /
    // NEXT_PUBLIC_SUPABASE_ANON_KEY are set, which this unit-test environment
    // does not set (other suites that need the live client mock the whole
    // module -- see app/hooks/__tests__/use-bid-updates.test.ts). Reading the
    // source directly still catches the regression this guards against: a
    // future edit that swaps `storageKey: OTTERQUOTE_AUTH_STORAGE_KEY` for a
    // hardcoded string literal, silently un-converging the React client from
    // the static stack.
    const supabaseTsPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'supabase.ts'
    );
    const source = readFileSync(supabaseTsPath, 'utf8');
    expect(source).toMatch(/storageKey:\s*OTTERQUOTE_AUTH_STORAGE_KEY\s*,/);
    expect(OTTERQUOTE_AUTH_STORAGE_KEY).toBe('sb-otterquote-auth');
  });
});

describe('gh-1980 PR 2: #488 regression -- sign-out must stick, not be undone by a leftover localStorage session', () => {
  beforeEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearCookies();
    try { window.localStorage.clear(); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('#488 REGRESSION (canonical key): a still-valid session under the CANONICAL key with no session cookies is signed out, not resurrected', () => {
    // No cookies exist (simulates a sign-out on the other subdomain, which
    // deletes only the shared cookies + that origin's own localStorage).
    // This origin's localStorage still has a live session under the
    // canonical key from before the sign-out.
    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'admin@example.com' });
    const raw = sessionJson(access, 'refresh-canonical', NOW + 3600);
    window.localStorage.setItem(OTTERQUOTE_AUTH_STORAGE_KEY, raw);

    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);

    const result = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);

    // The user must be treated as signed out, exactly as #488 requires.
    expect(result).toBeNull();
    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);
    expect(document.cookie).not.toContain(`${_COOKIE_REFRESH}=`);
    // The localStorage copy must be purged, not left to resurrect the
    // session on a later read.
    expect(window.localStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('#488 REGRESSION (legacy key): a still-valid session under a LEGACY (pre-convergence) key with no session cookies is signed out, not resurrected', () => {
    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'admin@example.com' });
    const raw = sessionJson(access, 'refresh-legacy', NOW + 3600);
    window.localStorage.setItem(LEGACY_KEY, raw);

    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);

    const result = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);

    expect(result).toBeNull();
    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);
    expect(document.cookie).not.toContain(`${_COOKIE_REFRESH}=`);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('an EXPIRED legacy-key session is signed out -- purge path unchanged', () => {
    const access = makeJwt({ sub: SUB, exp: NOW - 3600, iat: NOW - 7200, email: 'admin@example.com' });
    const raw = sessionJson(access, 'refresh-legacy-expired', NOW - 3600);
    window.localStorage.setItem(LEGACY_KEY, raw);

    const result = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);

    expect(result).toBeNull();
    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('a MALFORMED legacy-key value (not a parseable session) is signed out -- purge path unchanged', () => {
    window.localStorage.setItem(LEGACY_KEY, 'not-json-and-not-a-session');

    const result = otterquoteCookieStorage.getItem(OTTERQUOTE_AUTH_STORAGE_KEY);

    expect(result).toBeNull();
    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);
  });

  it('a freshly-built factory instance for a NON-canonical key also signs out on a leftover legacy session, never rewriting the shared cookies', () => {
    const access = makeJwt({ sub: SUB, exp: NOW + 3600, iat: NOW, email: 'admin@example.com' });
    const raw = sessionJson(access, 'refresh-legacy', NOW + 3600);
    window.localStorage.setItem(LEGACY_KEY, raw);

    const instance = createOtterQuoteCookieStorage('sb-some-other-caller-key');
    const result = instance.getItem('sb-some-other-caller-key');

    expect(result).toBeNull();
    expect(document.cookie).not.toContain(`${_COOKIE_ACCESS}=`);
  });
});
