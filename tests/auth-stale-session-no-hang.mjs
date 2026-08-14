/**
 * Regression test for #602 — js/auth.js getSession() INITIAL_SESSION guard.
 *
 * Root cause: the INITIAL_SESSION handler used `!hasStoredSession` (true for
 * ANY stored token, even an expired one) instead of `!session` as its
 * null-resolution predicate. A returning user with a stale/expired token
 * never hit `finish(null)` on the real INITIAL_SESSION event and the page
 * hung for 8s until the timeout fallback fired. This was also the confirmed
 * root cause of #643 (PWA sign-in loop): partner-dashboard.html's
 * `Auth.requireAuth()` retries `getSession()` in a loop after the first
 * 8s stall, compounding into a multi-stall bounce to sign-in.
 *
 * This test loads the real js/auth.js source into a minimal vm context with
 * a mock Supabase client that fires INITIAL_SESSION with session=null (the
 * real Supabase behavior when a stored refresh token has expired), and
 * asserts getSession() resolves promptly instead of waiting for the 6s/8s
 * timeout fallbacks.
 *
 * Run: node tests/auth-stale-session-no-hang.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

// A syntactically-real, EXPIRED JWT (exp in the past) so getSession()'s
// fast-path check fails and it falls through to the INITIAL_SESSION path —
// exactly the "stale stored token" scenario #602 describes.
function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const staleJwt = [
  base64url({ alg: 'HS256', typ: 'JWT' }),
  base64url({ sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 3600 }),
  'signature',
].join('.');

const staleSession = JSON.stringify({ access_token: staleJwt, refresh_token: 'stale-refresh-token' });

let onAuthStateChangeCallback = null;

const sandbox = {
  window: {
    location: { hash: '', search: '' },
    OtterQuoteCookieStorage: { getItem: () => staleSession },
    OTTERQUOTE_AUTH_STORAGE_KEY: 'sb-otterquote-auth',
  },
  CONFIG: { SUPABASE_URL: 'https://xyzsupabase.supabase.co' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null },
  console,
  setTimeout,
  Promise,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  sb: {
    auth: {
      onAuthStateChange(cb) {
        onAuthStateChangeCallback = cb;
        // Real Supabase behavior when the stored refresh token has expired
        // and the background refresh attempt fails: INITIAL_SESSION fires
        // with session:null. Simulate that asynchronously, same as the
        // real client would (not synchronously within registration).
        setTimeout(() => cb('INITIAL_SESSION', null), 5);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      getSession() {
        // The live client also reports no session — refresh already failed.
        return Promise.resolve({ data: { session: null } });
      },
      refreshSession() {
        return Promise.resolve({ data: { session: null } });
      },
    },
  },
};
sandbox.window.sb = sandbox.sb;
vm.createContext(sandbox);
vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).then((r) => {
    clearTimeout(timer);
    return r;
  });
}

async function main() {
  const start = Date.now();
  // Real fix should resolve within a handful of ms (one setTimeout(5) tick).
  // The pre-fix bug only resolves via the 6s refresh attempt / 8s timeout —
  // 500ms is a wide margin above the fixed path and a wide margin below the
  // broken path.
  const result = await withDeadline(sandbox.sb ? sandbox.window.Auth.getSession() : Promise.reject(), 500);
  const elapsed = Date.now() - start;

  if (result && result.__timedOut) {
    console.log('✗ FAIL: getSession() did not resolve within 500ms for a stale/expired stored session.');
    console.log('  This is the #602 regression: INITIAL_SESSION fired with session=null but finish(null)');
    console.log('  was not called (likely reverted to the `!hasStoredSession` predicate).');
    process.exit(1);
  }

  if (result !== null) {
    console.log(`✗ FAIL: expected getSession() to resolve to null for a stale session, got: ${JSON.stringify(result)}`);
    process.exit(1);
  }

  console.log(`✓ PASS: getSession() resolved to null in ${elapsed}ms for a stale/expired stored session (no 8s hang).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
