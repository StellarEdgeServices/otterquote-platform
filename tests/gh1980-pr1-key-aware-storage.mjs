/**
 * gh-1980 PR 1/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") -- static
 * stack (js/cookie-storage.js) mirror of the react-app suite's
 * gh1980-pr1-key-aware-storage.test.ts. Step 1 of Marty's three-PR sequence
 * (#1931 artifact 3, ruling quoted verbatim on #1980): "Make both storage
 * adapters key-aware. No behaviour change, fully testable, no user impact."
 *
 * Runs the REAL js/cookie-storage.js, unmodified, in a vm context with a
 * minimal but faithful cookie/localStorage shim -- same harness pattern as
 * tests/gh2154-p1-cookie-storage-updateuser.mjs (no cookie-storage logic
 * stubbed).
 *
 * Fail-first: window.createOtterQuoteCookieStorage does not exist on the
 * pre-PR-1 file (only window.OtterQuoteCookieStorage, the bound singleton)
 * -- every assertion below fails on that commit. See the PR/issue comment
 * for the raw pre-fix run.
 *
 * Run: node tests/gh1980-pr1-key-aware-storage.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
  };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function makeJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  return b64url(header) + '.' + b64url(payload) + '.sig';
}

function buildRealm(cookieStorageSrc) {
  const localStorage = makeLocalStorage();
  const cookieDoc = makeCookieJar();
  const windowObj = {
    location: { hostname: 'otterquote.com', origin: 'https://otterquote.com', protocol: 'https:' },
  };
  windowObj.localStorage = localStorage;
  windowObj.document = cookieDoc;

  const ctx = {
    window: windowObj,
    document: cookieDoc,
    localStorage,
    console,
    Promise, Array, Object, JSON, Math, Date, Error, TypeError, RangeError, String, Number, Boolean,
    Map, Set, RegExp, encodeURIComponent, decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  ctx.globalThis = ctx;
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(cookieStorageSrc, ctx, { filename: 'js/cookie-storage.js (real)' });
  return { ctx, cookieDoc, localStorage };
}

const STORAGE_KEY = 'sb-otterquote-auth';
const COOKIE_ACCESS = 'sb-otterquote-at';
const COOKIE_REFRESH = 'sb-otterquote-rt';

function main() {
  const cookieStorageSrc = fs.readFileSync(path.join(repoRoot, 'js', 'cookie-storage.js'), 'utf8');

  // (1) The factory exists on window.
  {
    try {
      const { ctx } = buildRealm(cookieStorageSrc);
      ok(typeof ctx.window.createOtterQuoteCookieStorage === 'function',
        '(1) window.createOtterQuoteCookieStorage is a function');
    } catch (e) {
      failWithReason('(1) factory existence', e.message);
    }
  }

  // (2) The default singleton is built from the factory bound to the
  // canonical key -- reading through either returns the same session.
  {
    try {
      const { ctx } = buildRealm(cookieStorageSrc);
      const access = makeJwt({ sub: 'user-abc', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) });
      ctx.document.cookie = COOKIE_ACCESS + '=' + encodeURIComponent(access) + '; path=/';
      ctx.document.cookie = COOKIE_REFRESH + '=refresh-abc; path=/';

      const rebuilt = ctx.window.createOtterQuoteCookieStorage(STORAGE_KEY);
      const viaSingleton = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      const viaFactory = rebuilt.getItem(STORAGE_KEY);
      ok(viaFactory === viaSingleton, '(2) factory-built instance for the canonical key matches the singleton -- got ' + JSON.stringify({ viaFactory, viaSingleton }));
      ok(JSON.parse(viaFactory).user.id === 'user-abc', '(2) session reconstructed correctly through the factory instance');
    } catch (e) {
      failWithReason('(2) singleton parity', e.message);
    }
  }

  // (3) Two independently-keyed instances are genuinely separate objects.
  {
    try {
      const { ctx } = buildRealm(cookieStorageSrc);
      const instanceA = ctx.window.createOtterQuoteCookieStorage('sb-otterquote-auth');
      const instanceB = ctx.window.createOtterQuoteCookieStorage('sb-some-other-project-auth-token');
      ok(instanceA !== instanceB, '(3) two factory instances are distinct objects');
      ok(instanceA !== ctx.window.OtterQuoteCookieStorage, '(3) a freshly-built instance is not === the page-global singleton');
    } catch (e) {
      failWithReason('(3) instance identity', e.message);
    }
  }

  // (4) Parity: auxiliary (code-verifier) key on a factory-built instance
  // behaves exactly like the singleton -- localStorage-only, cookies
  // undisturbed.
  {
    try {
      const { ctx } = buildRealm(cookieStorageSrc);
      const access = makeJwt({ sub: 'user-def', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) });
      ctx.document.cookie = COOKIE_ACCESS + '=' + encodeURIComponent(access) + '; path=/';
      ctx.document.cookie = COOKIE_REFRESH + '=refresh-def; path=/';

      const instance = ctx.window.createOtterQuoteCookieStorage(STORAGE_KEY);
      const verifierKey = STORAGE_KEY + '-code-verifier';
      instance.setItem(verifierKey, 'the-verifier-value');
      ok(instance.getItem(verifierKey) === 'the-verifier-value', '(4) auxiliary key round-trips through localStorage on a factory instance');
      ok(ctx.document.has(COOKIE_ACCESS) && ctx.document.has(COOKIE_REFRESH), '(4) session cookies undisturbed by an auxiliary-key write');
    } catch (e) {
      failWithReason('(4) auxiliary key parity', e.message);
    }
  }

  // (5) Parity: removeItem() on a factory-built instance for a NON-canonical
  // key still clears the shared session cookies -- same invariant PR
  // #2162 round 4/5 fixed for the singleton; must hold for any instance.
  {
    try {
      const { ctx } = buildRealm(cookieStorageSrc);
      const access = makeJwt({ sub: 'user-ghi', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) });
      ctx.document.cookie = COOKIE_ACCESS + '=' + encodeURIComponent(access) + '; path=/';
      ctx.document.cookie = COOKIE_REFRESH + '=refresh-ghi; path=/';

      const instance = ctx.window.createOtterQuoteCookieStorage('sb-some-other-project-auth-token');
      instance.removeItem('sb-some-other-project-auth-token');
      ok(!ctx.document.has(COOKIE_ACCESS) && !ctx.document.has(COOKIE_REFRESH),
        '(5) removeItem() on a non-canonical-key instance still clears the shared session cookies (no round-4 regression)');
    } catch (e) {
      failWithReason('(5) removeItem parity', e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main();
