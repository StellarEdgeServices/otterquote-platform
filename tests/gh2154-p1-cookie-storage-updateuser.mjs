/**
 * gh-2154 P-1 / PR #2162 review round 4 (comment 5825170286) --
 * "any rejected sb.auth.updateUser() signs the user out."
 *
 * supabase-js 2.112.4's `_updateUser` always runs its PKCE code-verifier
 * cleanup on ANY updateUser error (regardless of flow type or whether email
 * was part of the payload): `storage.removeItem('<storageKey>-code-verifier')`.
 * `js/cookie-storage.js`'s `removeItem(key)` used to IGNORE the key it was
 * given and unconditionally delete the `sb-otterquote-at` / `sb-otterquote-rt`
 * session cookies plus the legacy `sb-*-auth-token` keys -- so a single
 * rejected updateUser (a HIBP "weak password" 422, or a plain 500) wiped the
 * whole session, even though nothing asked to sign out.
 *
 * On the P-1 set-password card (partner-dashboard.html ~1490/1527) this is a
 * dead end: the partner has no known password (short-signup never collects
 * one -- it's generated via CSPRNG and never shown to them), so once signed
 * out there they have no way back in except "Forgot password?", which
 * nothing on screen points to. The same mechanism fires on the signup pages'
 * `updateUser({data:{needs_password:true}})` error path (partner-re.html,
 * partner-insurance.html, partner-inspectors.html) and on
 * partner-login.html's post-reset metadata clear.
 *
 * The reviewer's finding (and prior 172/172-passing suites) note that a vm
 * STUB `sb` object -- as tests/gh2154-p1-set-password.mjs and friends use --
 * never exercises `_updateUser`'s real storage cleanup, which is exactly why
 * it went unnoticed. This test instead runs:
 *   - the REAL supabase-js 2.112.4 UMD bundle, fetched from the exact CDN
 *     URL the pages pin and byte-verified against the SAME SRI hash those
 *     pages carry (so a version/CDN drift fails loudly instead of silently
 *     testing something the site doesn't actually ship), and
 *   - the REAL js/cookie-storage.js source, unmodified, loaded into a vm
 *     context with a minimal but faithful browser shim (document.cookie,
 *     localStorage, window.location) -- no cookie-storage logic is stubbed.
 * A stubbed `fetch` stands in for the Supabase Auth HTTP API, since no
 * browser or live project is available in this CI job.
 *
 * Run: node tests/gh2154-p1-cookie-storage-updateuser.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.js';

/**
 * Fetch the REAL supabase-js UMD bundle and verify its SRI hash matches, byte
 * for byte, the hash pinned in the pages that actually load it in production
 * -- so this test proves something about what ships, not about whatever
 * happens to be on the CDN today.
 */
async function loadRealSupabaseJs() {
  let pinnedIntegrity = null;
  for (const page of ['partner-dashboard.html', 'partner-login.html']) {
    const html = fs.readFileSync(path.join(repoRoot, page), 'utf8');
    const m = html.match(/supabase-js@2\.112\.4\/dist\/umd\/supabase\.js"\s+integrity="([^"]+)"/);
    if (!m) throw new Error(page + ': could not find the pinned supabase-js <script> tag (integrity attribute)');
    if (pinnedIntegrity === null) pinnedIntegrity = m[1];
    else if (pinnedIntegrity !== m[1]) {
      throw new Error('partner-dashboard.html and partner-login.html pin DIFFERENT supabase-js SRI hashes: ' +
        pinnedIntegrity + ' vs ' + m[1]);
    }
  }
  if (!pinnedIntegrity) throw new Error('no page yielded a pinned supabase-js integrity hash to verify against');

  const res = await fetch(SUPABASE_JS_URL);
  if (!res.ok) throw new Error('failed to fetch real supabase-js bundle: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
  if (digest !== pinnedIntegrity) {
    throw new Error('fetched supabase-js SRI (' + digest + ') does not match the hash pinned in the pages (' + pinnedIntegrity + ')');
  }
  return buf.toString('utf8');
}

/** A minimal document.cookie jar: supports the exact write format
 *  js/cookie-storage.js uses (`key=value; Path=/...; Max-Age=N; ...`) and the
 *  exact read format it expects (`k1=v1; k2=v2`). */
function makeCookieJar() {
  const jar = new Map();
  return {
    get cookie() {
      return Array.from(jar.entries()).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('; ');
    },
    set cookie(str) {
      const firstPart = String(str).split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx === -1) return;
      const key = firstPart.slice(0, eqIdx);
      const rawVal = firstPart.slice(eqIdx + 1);
      const maxAgeMatch = /Max-Age=(-?\d+)/i.exec(str);
      if (maxAgeMatch && parseInt(maxAgeMatch[1], 10) <= 0) {
        jar.delete(key);
        return;
      }
      try { jar.set(key, decodeURIComponent(rawVal)); } catch (e) { jar.set(key, rawVal); }
    },
    _jar: jar,
    has(key) { return jar.has(key); },
  };
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
    _store: store,
  };
}

/** Base64url-encode a JSON payload the same way a real JWT segment is
 *  encoded, so supabase-js's own strict base64url JWT decoder (used to read
 *  `exp`/`sub` off the access token during setSession) accepts it. */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeFakeAccessToken(sub) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub, aud: 'authenticated', role: 'authenticated',
    email: 'partner-' + sub + '@example.com',
    exp: nowSec + 24 * 3600, iat: nowSec,
  };
  // supabase-js validates each JWT segment against a base64url length
  // pattern (no length %4===1 remainder) -- a plain word like "fakesignature"
  // (13 chars) fails it, so use random bytes through the same base64url
  // encoder real signatures use.
  const fakeSignature = crypto.randomBytes(32).toString('base64url');
  return b64url(header) + '.' + b64url(payload) + '.' + fakeSignature;
}

/** Builds one isolated vm realm: real cookie-storage.js + real supabase-js,
 *  a fresh cookie jar / localStorage, and a fresh Supabase client already
 *  signed in (session cookies present) -- via setSession(), so no signup or
 *  password-grant network call is needed. */
async function freshSignedInEnv(supabaseSrc, cookieStorageSrc, { userId, fetchImpl, configStyle }) {
  const localStorage = makeLocalStorage();
  const cookieDoc = makeCookieJar();
  const windowObj = {
    location: { hostname: 'app.otterquote.com', origin: 'https://app.otterquote.com', protocol: 'https:' },
    history: {},
    addEventListener() {}, removeEventListener() {},
  };
  windowObj.localStorage = localStorage;
  windowObj.document = cookieDoc;

  const ctx = {
    window: windowObj,
    document: cookieDoc,
    localStorage,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto,
    Promise, Array, Object, JSON, Math, Date, Error, TypeError, RangeError, String, Number, Boolean,
    Map, Set, RegExp, encodeURIComponent, decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams, AbortController, AbortSignal,
    structuredClone, process, Response, Headers, Request,
    WebSocket: globalThis.WebSocket, BroadcastChannel: globalThis.BroadcastChannel,
    navigator: { userAgent: 'node-test' },
    fetch: fetchImpl,
  };
  ctx.globalThis = ctx;
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(cookieStorageSrc, ctx, { filename: 'js/cookie-storage.js (real)' });
  vm.runInContext(supabaseSrc, ctx, { filename: 'supabase-js 2.112.4 UMD (real, jsdelivr, SRI-verified)' });

  // gh-2162 review round 5: `configStyle` builds the client EXACTLY the way
  // js/config.js's `_oqCreateSupabaseClient()` does (js/config.js:146) --
  // `{ auth: { storage: window.OtterQuoteCookieStorage } }`, no `storageKey`
  // at all. supabase-js then falls back to ITS OWN default,
  // `sb-<project-ref>-auth-token`, derived from the URL host's first label
  // -- never the canonical `sb-otterquote-auth` js/supabase-client.js passes
  // explicitly. Most partner pages (partner-login.html, the signup pages)
  // use exactly this config.js client, so this is the effective storageKey
  // in production far more often than the explicit one below.
  const authOptions = configStyle
    ? { storage: ctx.window.OtterQuoteCookieStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }
    : { storage: ctx.window.OtterQuoteCookieStorage, storageKey: 'sb-otterquote-auth', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false };

  const client = ctx.supabase.createClient(
    'https://fake-project.supabase.co',
    'fake-anon-key',
    { auth: authOptions }
  );

  const accessToken = makeFakeAccessToken(userId);
  const { error: setSessionError } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: 'fake-refresh-token-' + userId,
  });
  if (setSessionError) throw new Error('test setup: setSession() failed: ' + setSessionError.message);

  return { ctx, client, cookieDoc, localStorage };
}

const STORAGE_KEY = 'sb-otterquote-auth';
const COOKIE_ACCESS = 'sb-otterquote-at';
const COOKIE_REFRESH = 'sb-otterquote-rt';

function sessionCookiesPresent(cookieDoc) {
  return cookieDoc.has(COOKIE_ACCESS) && cookieDoc.has(COOKIE_REFRESH);
}

/** A GoTrue-shaped fetch stub. `updatePutResponses` is a queue of canned
 *  Response-producing functions consumed in order by successive
 *  `PUT .../user` calls (updateUser). `onLogout` responds to POST logout. */
function makeFetchStub({ userId, updatePutResponses, onLogout }) {
  const putQueue = updatePutResponses.slice();
  const calls = [];
  return {
    calls,
    async fetch(rawUrl, init) {
      const url = new URL(String(rawUrl));
      const method = (init && init.method) || 'GET';
      calls.push({ method, pathname: url.pathname });

      if (url.pathname.endsWith('/user') && method === 'GET') {
        return new Response(JSON.stringify({
          id: userId, aud: 'authenticated', role: 'authenticated',
          email: 'partner-' + userId + '@example.com',
          phone: '', app_metadata: {}, user_metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          confirmed_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(),
          identities: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (url.pathname.endsWith('/user') && method === 'PUT') {
        const next = putQueue.shift();
        if (!next) throw new Error('unexpected PUT /user call -- no canned response queued (call #' + calls.length + ')');
        return next();
      }

      if (url.pathname.endsWith('/logout')) {
        if (onLogout) onLogout();
        return new Response(null, { status: 204 });
      }

      throw new Error('unexpected fetch in test stub: ' + method + ' ' + url.pathname);
    },
  };
}

function weakPasswordResponse() {
  return new Response(JSON.stringify({
    code: 'weak_password',
    message: 'Password is known to be weak and easy to guess, please choose a different one.',
    weak_password: { reasons: ['pwned'] },
  }), {
    status: 422,
    headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
  });
}

function serverErrorResponse() {
  return new Response(JSON.stringify({ message: 'Internal Server Error' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

function successUpdateResponse(userId, extraMetadata) {
  return new Response(JSON.stringify({
    id: userId, aud: 'authenticated', role: 'authenticated',
    email: 'partner-' + userId + '@example.com',
    phone: '', app_metadata: {}, user_metadata: Object.assign({}, extraMetadata),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(),
    identities: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function main() {
  const supabaseSrc = await loadRealSupabaseJs();
  const cookieStorageSrc = fs.readFileSync(path.join(repoRoot, 'js', 'cookie-storage.js'), 'utf8');

  // ── (1) HIBP weak-password rejection on the set-password card: session
  // cookies must survive, and a retry with a strong password must succeed. ──
  {
    const stub = makeFetchStub({
      userId: 'user-1',
      updatePutResponses: [
        weakPasswordResponse,
        () => successUpdateResponse('user-1', { needs_password: false }),
      ],
    });
    try {
      const { client, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-1', fetchImpl: stub.fetch,
      });
      ok(sessionCookiesPresent(cookieDoc), '(1) setup: session cookies present right after sign-in');

      const { error: weakErr } = await client.auth.updateUser({ password: 'password123' });
      ok(!!weakErr, '(1) weak-password updateUser() call returns an error (HIBP 422)');
      ok(sessionCookiesPresent(cookieDoc), '(1) MUST-FIX: session cookies SURVIVE a rejected updateUser()');

      const { error: retryErr } = await client.auth.updateUser({ password: 'Str0ng!Passw0rd-2162', data: { needs_password: false } });
      ok(!retryErr, '(1) retry with a strong password succeeds -- got ' + (retryErr && retryErr.message));
      ok(sessionCookiesPresent(cookieDoc), '(1) session cookies still present after the successful retry');
    } catch (e) {
      failWithReason('(1) weak-password / retry scenario', e.message);
    }
  }

  // ── (2) a 500 on the signup pages' needs_password write must not sign the
  // partner out either -- same mechanism, any rejected updateUser(). ──
  {
    const stub = makeFetchStub({
      userId: 'user-2',
      updatePutResponses: [serverErrorResponse],
    });
    try {
      const { client, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-2', fetchImpl: stub.fetch,
      });
      const { error } = await client.auth.updateUser({ data: { needs_password: true } });
      ok(!!error, '(2) 500 on needs_password write returns an error');
      ok(sessionCookiesPresent(cookieDoc), '(2) session cookies SURVIVE a 500 on the signup-page metadata write');
    } catch (e) {
      failWithReason('(2) signup-page 500 scenario', e.message);
    }
  }

  // ── (3) a 500 on partner-login.html's post-reset metadata clear must not
  // sign the partner out -- they'd otherwise be bounced right after resetting. ──
  {
    const stub = makeFetchStub({
      userId: 'user-3',
      updatePutResponses: [serverErrorResponse],
    });
    try {
      const { client, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-3', fetchImpl: stub.fetch,
      });
      const { error } = await client.auth.updateUser({ data: { needs_password: false } });
      ok(!!error, '(3) 500 on login-page metadata clear returns an error');
      ok(sessionCookiesPresent(cookieDoc), '(3) session cookies SURVIVE a 500 on the login-page metadata clear');
    } catch (e) {
      failWithReason('(3) login-page 500 scenario', e.message);
    }
  }

  // ── (4) NEGATIVE CONTROL: signOut() must still clear everything -- the
  // fix must not turn removeItem into a no-op for the canonical key. ──
  {
    let logoutCalled = false;
    const stub = makeFetchStub({
      userId: 'user-4',
      updatePutResponses: [],
      onLogout: () => { logoutCalled = true; },
    });
    try {
      const { client, cookieDoc, localStorage } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-4', fetchImpl: stub.fetch,
      });
      // Seed a legacy key the way an old contractor session would have left one.
      localStorage.setItem('sb-oldproj-auth-token', 'stale-legacy-session-json');
      ok(sessionCookiesPresent(cookieDoc), '(4) setup: session cookies present before signOut()');

      const { error } = await client.auth.signOut();
      ok(!error, '(4) signOut() itself does not error -- got ' + (error && error.message));
      ok(logoutCalled, '(4) signOut() actually called POST /logout');
      ok(!sessionCookiesPresent(cookieDoc), '(4) NEGATIVE CONTROL: signOut() clears the session cookies');
      ok(localStorage.getItem('sb-oldproj-auth-token') === null, '(4) NEGATIVE CONTROL: signOut() clears legacy sb-*-auth-token keys');
    } catch (e) {
      failWithReason('(4) signOut negative control', e.message);
    }
  }

  // ── (5) getItem() on a non-canonical key (e.g. the PKCE code-verifier key)
  // must never return the session -- the same bug class as removeItem. ──
  {
    const stub = makeFetchStub({ userId: 'user-5', updatePutResponses: [] });
    try {
      const { ctx, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-5', fetchImpl: stub.fetch,
      });
      ok(sessionCookiesPresent(cookieDoc), '(5) setup: session cookies present');

      const verifierKey = STORAGE_KEY + '-code-verifier';
      const readBeforeWrite = ctx.window.OtterQuoteCookieStorage.getItem(verifierKey);
      ok(readBeforeWrite === null, '(5) getItem(non-canonical key) does NOT return the session while cookies are present -- got ' + JSON.stringify(readBeforeWrite));

      ctx.window.OtterQuoteCookieStorage.setItem(verifierKey, 'the-actual-pkce-verifier-value');
      const readAfterWrite = ctx.window.OtterQuoteCookieStorage.getItem(verifierKey);
      ok(readAfterWrite === 'the-actual-pkce-verifier-value', '(5) setItem/getItem round-trip on a non-canonical key uses plain localStorage, unaffected by cookies -- got ' + JSON.stringify(readAfterWrite));
      ok(sessionCookiesPresent(cookieDoc), '(5) writing a non-canonical key does not disturb the session cookies');
    } catch (e) {
      failWithReason('(5) getItem/setItem non-canonical key scenario', e.message);
    }
  }

  // ── (6) gh-2162 review round 5: a client built EXACTLY like js/config.js's
  // own `_oqCreateSupabaseClient()` -- no storageKey, so supabase-js falls
  // back to its own default (`sb-<ref>-auth-token`, never
  // 'sb-otterquote-auth'). This is the client partner-login.html and the
  // signup pages actually use. Sign-in must still write the session cookies,
  // getItem must still reconstruct the session from them, and signOut must
  // still delete them -- the round-4 allowlist-by-exact-key fix broke all
  // three because it only recognized the canonical key. ──
  {
    let logoutCalled = false;
    const stub = makeFetchStub({
      userId: 'user-6', updatePutResponses: [], onLogout: () => { logoutCalled = true; },
    });
    try {
      const { client, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-6', fetchImpl: stub.fetch, configStyle: true,
      });
      ok(sessionCookiesPresent(cookieDoc), '(6) config.js-style client (no storageKey): sign-in writes the session cookies');

      const { data: sessionData, error: getSessionErr } = await client.auth.getSession();
      ok(!getSessionErr && !!(sessionData && sessionData.session), '(6) config.js-style client: getItem() reconstructs the session from the cookies -- got error=' + (getSessionErr && getSessionErr.message));

      const { error: signOutErr } = await client.auth.signOut();
      ok(!signOutErr, '(6) config.js-style client: signOut() itself does not error -- got ' + (signOutErr && signOutErr.message));
      ok(logoutCalled, '(6) config.js-style client: signOut() actually called POST /logout');
      ok(!sessionCookiesPresent(cookieDoc), '(6) config.js-style client: signOut() DOES clear the session cookies (round-4 regression check)');
    } catch (e) {
      failWithReason('(6) config.js-style client (no storageKey) scenario', e.message);
    }
  }

  // ── (7) the same weak-password-survives case as (1), but on the
  // config.js-style client -- the exact client partner-dashboard.html's
  // set-password card and the signup pages actually run under. ──
  {
    const stub = makeFetchStub({
      userId: 'user-7',
      updatePutResponses: [weakPasswordResponse, () => successUpdateResponse('user-7', { needs_password: false })],
    });
    try {
      const { client, cookieDoc } = await freshSignedInEnv(supabaseSrc, cookieStorageSrc, {
        userId: 'user-7', fetchImpl: stub.fetch, configStyle: true,
      });
      ok(sessionCookiesPresent(cookieDoc), '(7) config.js-style client: setup, session cookies present');

      const { error: weakErr } = await client.auth.updateUser({ password: 'password123' });
      ok(!!weakErr, '(7) config.js-style client: weak-password updateUser() returns an error');
      ok(sessionCookiesPresent(cookieDoc), '(7) config.js-style client: session cookies SURVIVE a rejected updateUser() (round-4 regression check)');

      const { error: retryErr } = await client.auth.updateUser({ password: 'Str0ng!Passw0rd-2162', data: { needs_password: false } });
      ok(!retryErr, '(7) config.js-style client: retry with a strong password succeeds -- got ' + (retryErr && retryErr.message));
      ok(sessionCookiesPresent(cookieDoc), '(7) config.js-style client: session cookies still present after the successful retry');
    } catch (e) {
      failWithReason('(7) config.js-style client weak-password scenario', e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.stack || e));
  process.exit(1);
});
