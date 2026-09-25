/**
 * gh-2168 — mirror of PR #2162 review round 4 (comment 5825170286) / round 5,
 * this time for the React app's adapter.
 *
 * js/cookie-storage.js's `removeItem(key)` used to IGNORE the key it was
 * given and unconditionally delete the shared `sb-otterquote-at` /
 * `sb-otterquote-rt` session cookies. supabase-js's `_updateUser` calls
 * `storage.removeItem('<storageKey>-code-verifier')` on ANY updateUser
 * error (HIBP weak-password 422, a plain 500, whatever) as part of its PKCE
 * cleanup — see node_modules/@supabase/auth-js/dist/main/GoTrueClient.js
 * `_updateUser`'s catch block, which unconditionally calls
 * `removePKCEVerifier(this.storage, this.storageKey, flowId)` even when
 * `flowId` is null, and helpers.js's `removePKCEVerifier` then does
 * `removeItemAsync(storage, \`${storageKey}-code-verifier\`)`. That is not a
 * sign-out, but a key-blind removeItem wiped the whole session anyway.
 *
 * `react-app/app/lib/cookie-storage.ts` had the exact same key-blind
 * `removeItem` (confirmed by the Opus reviewer of #2162, comment
 * 5825777290) — this test proves it with the REAL `@supabase/supabase-js`
 * client (no stubbed `sb` object) and the REAL adapter module, run under
 * vitest's jsdom environment (real `document.cookie` / `window.localStorage`,
 * no vm sandbox needed since this file is TS, unlike the static stack's
 * plain-node test).
 *
 * Only the Supabase Auth HTTP layer (`fetch`) is stubbed, since no live
 * project is available in this CI job.
 *
 * Run: npm test -- cookie-storage.updateuser (or `npm test` for the full
 * suite). Fails on main (session cookies deleted by a rejected updateUser);
 * passes once cookie-storage.ts's removeItem is key-aware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
} from '../cookie-storage';

function clearCookies(): void {
  for (const pair of document.cookie.split('; ')) {
    const k = pair.split('=')[0];
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
}

function sessionCookiesPresent(): boolean {
  const jar = document.cookie;
  return jar.includes(`${_COOKIE_ACCESS}=`) && jar.includes(`${_COOKIE_REFRESH}=`);
}

/** base64url-encode a JSON payload the same way a real JWT segment is
 *  encoded, so supabase-js's own JWT decoder (used during setSession /
 *  updateUser) accepts it. */
function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomB64url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeFakeAccessToken(sub: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    aud: 'authenticated',
    role: 'authenticated',
    email: `partner-${sub}@example.com`,
    exp: nowSec + 24 * 3600,
    iat: nowSec,
  };
  return `${b64url(header)}.${b64url(payload)}.${randomB64url(32)}`;
}

/** Test credentials are assembled at runtime, never written as a
 *  secret-shaped literal, so scanners (GitGuardian) don't flag a fake
 *  password the way a real one would be flagged — see #2162's incident
 *  37588523 (false positive) and #2166 (runtime-built literal fix), which
 *  this mirrors. Neither value is a real credential. */
function buildWeakTestPassword(): string {
  return ['password', '123'].join('');
}

function buildStrongTestPassword(suffix: string): string {
  return ['Str0ng!Passw0rd-', suffix].join('');
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function weakPasswordResponse(): Response {
  return jsonResponse(
    {
      code: 'weak_password',
      message: 'Password is known to be weak and easy to guess, please choose a different one.',
      weak_password: { reasons: ['pwned'] },
    },
    422
  );
}

function serverErrorResponse(): Response {
  return jsonResponse({ message: 'Internal Server Error' }, 500);
}

function userResponse(userId: string, extraMetadata: Record<string, unknown> = {}): Response {
  return jsonResponse(
    {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: `partner-${userId}@example.com`,
      phone: '',
      app_metadata: {},
      user_metadata: extraMetadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      last_sign_in_at: new Date().toISOString(),
      identities: [],
    },
    200
  );
}

/** A GoTrue-shaped fetch stub. `putQueue` is consumed in order by successive
 *  PUT .../user calls (updateUser). */
function makeFetchStub(opts: {
  userId: string;
  putQueue: Array<() => Response>;
  onLogout?: () => void;
}) {
  const queue = opts.putQueue.slice();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init && init.method) || 'GET';

    if (url.pathname.endsWith('/user') && method === 'GET') {
      return userResponse(opts.userId);
    }
    if (url.pathname.endsWith('/user') && method === 'PUT') {
      const next = queue.shift();
      if (!next) throw new Error('unexpected PUT /user call — no canned response queued');
      return next();
    }
    if (url.pathname.endsWith('/logout')) {
      if (opts.onLogout) opts.onLogout();
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch in test stub: ${method} ${url.pathname}`);
  };
}

/** Builds a real supabase-js client wired to the REAL otterquoteCookieStorage
 *  adapter (mirrors react-app/app/lib/supabase.ts exactly), then signs it in
 *  via setSession() so no network call is needed for login. */
async function freshSignedInClient(userId: string, fetchImpl: typeof fetch) {
  const client = createClient('https://fake-project.supabase.co', 'fake-anon-key', {
    auth: {
      persistSession: true,
      storageKey: OTTERQUOTE_AUTH_STORAGE_KEY,
      storage: otterquoteCookieStorage,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });

  const accessToken = makeFakeAccessToken(userId);
  const { error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: `fake-refresh-token-${userId}`,
  });
  if (error) throw new Error(`test setup: setSession() failed: ${error.message}`);
  return client;
}

describe('gh-2168: cookie-storage.ts removeItem is key-aware (real supabase-js)', () => {
  beforeEach(() => {
    clearCookies();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => {
    clearCookies();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('(1) session cookies SURVIVE a HIBP weak-password updateUser() rejection, and a retry succeeds', async () => {
    const fetchImpl = makeFetchStub({
      userId: 'user-1',
      putQueue: [weakPasswordResponse, () => userResponse('user-1', { needs_password: false })],
    });
    const client = await freshSignedInClient('user-1', fetchImpl);
    expect(sessionCookiesPresent()).toBe(true);

    const { error: weakErr } = await client.auth.updateUser({ password: buildWeakTestPassword() });
    expect(weakErr).toBeTruthy();
    // MUST-FIX: a key-blind removeItem('<storageKey>-code-verifier') must not
    // delete the session cookies. FAILS on main.
    expect(sessionCookiesPresent()).toBe(true);

    const { error: retryErr } = await client.auth.updateUser({
      password: buildStrongTestPassword('2168'),
      data: { needs_password: false },
    });
    expect(retryErr).toBeNull();
    expect(sessionCookiesPresent()).toBe(true);
  });

  it('(2) session cookies SURVIVE a 500 on a metadata-only updateUser() call', async () => {
    const fetchImpl = makeFetchStub({ userId: 'user-2', putQueue: [serverErrorResponse] });
    const client = await freshSignedInClient('user-2', fetchImpl);

    const { error } = await client.auth.updateUser({ data: { needs_password: true } });
    expect(error).toBeTruthy();
    expect(sessionCookiesPresent()).toBe(true);
  });

  it('(3) NEGATIVE CONTROL: signOut() still clears the session cookies', async () => {
    let logoutCalled = false;
    const fetchImpl = makeFetchStub({
      userId: 'user-3',
      putQueue: [],
      onLogout: () => {
        logoutCalled = true;
      },
    });
    const client = await freshSignedInClient('user-3', fetchImpl);
    // 'sb_at' is the React-stack pre-fix legacy key cookie-storage.ts's own
    // LEGACY_KEYS constant names (see cookie-storage.ts) — seed it the way a
    // stale pre-D-212 session would have left one.
    window.localStorage.setItem('sb_at', 'stale-legacy-session-json');
    expect(sessionCookiesPresent()).toBe(true);

    const { error } = await client.auth.signOut();
    expect(error).toBeNull();
    expect(logoutCalled).toBe(true);
    expect(sessionCookiesPresent()).toBe(false);
    expect(window.localStorage.getItem('sb_at')).toBeNull();
  });

  it('(4) NEGATIVE CONTROL: a direct removeItem() on an auxiliary key never touches the session cookies', () => {
    // Exercises the adapter directly (no client), the same way #2162's issue
    // context frames the bug class: "a remove of an auxiliary key must never
    // delete the session cookie."
    document.cookie = `${_COOKIE_ACCESS}=fake-at; path=/`;
    document.cookie = `${_COOKIE_REFRESH}=fake-rt; path=/`;
    expect(sessionCookiesPresent()).toBe(true);

    otterquoteCookieStorage.removeItem(`${OTTERQUOTE_AUTH_STORAGE_KEY}-code-verifier`);
    expect(sessionCookiesPresent()).toBe(true);

    otterquoteCookieStorage.removeItem(`${OTTERQUOTE_AUTH_STORAGE_KEY}-user`);
    expect(sessionCookiesPresent()).toBe(true);

    // Removing the canonical key itself must still clear the cookies.
    otterquoteCookieStorage.removeItem(OTTERQUOTE_AUTH_STORAGE_KEY);
    expect(sessionCookiesPresent()).toBe(false);
  });
});
