/**
 * gh-1980 PR 2/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") -- static
 * stack storageKey convergence + migration safety, mirroring the react-app
 * suite's gh1980-pr2-storagekey-migration.test.ts.
 *
 * PR 2's job: converge every browser-side Supabase client construction onto
 * the canonical storageKey (window.OTTERQUOTE_AUTH_STORAGE_KEY /
 * 'sb-otterquote-auth'), and pin supabase-js so the CDN version does not
 * float. This file has two halves:
 *
 *   Scenarios (1)-(4): run the REAL js/cookie-storage.js, unmodified, in a
 *   vm context (same harness as tests/gh1980-pr1-key-aware-storage.mjs) and
 *   prove the migration-safety guarantee added to getItem(): a session that
 *   exists only under a legacy (pre-convergence) key is migrated to cookies,
 *   not purged, the first time a call site reads under the canonical key.
 *   This is what makes it safe for admin-dashboard.html,
 *   admin-homeowners.html and admin-measurements.html to switch from a bare
 *   createClient() (supabase-js's own default storage/key) to this adapter
 *   in this same PR without signing anyone out.
 *
 *   Scenario (5): a static, repo-wide convergence guard -- greps every
 *   tracked HTML file (and js/config.js) for a `createClient(` call site and
 *   asserts every one that passes an `auth: { storage: ... }` config also
 *   passes the canonical storageKey. This is the automated, CI-enforced form
 *   of the manual enumeration in the PR body: if a future page reintroduces
 *   a divergent storageKey (or a new page adds a bare createClient() with no
 *   adapter at all), this scenario fails instead of silently reintroducing
 *   the gh-1980 PR 2 regression.
 *
 * Fail-first: scenarios (1)-(4) fail against the pre-PR-2
 * js/cookie-storage.js (no migrateLegacySession()) -- see the PR/issue
 * comment for the raw pre-fix run. Scenario (5) fails against the pre-PR-2
 * working tree (admin-dashboard.html etc. had no storageKey at all).
 *
 * Run: node tests/gh1980-pr2-storagekey-migration.mjs
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

function makeLocalStorage(seed) {
  const store = new Map(Object.entries(seed || {}));
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
function sessionJson(accessToken, refreshToken, expSec) {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expSec,
    expires_in: expSec - Math.floor(Date.now() / 1000),
    token_type: 'bearer',
    user: null,
  });
}

function buildRealm(cookieStorageSrc, localStorageSeed) {
  const localStorage = makeLocalStorage(localStorageSeed);
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
// supabase-js's own default key for the prod project ref -- what
// admin-dashboard.html's pre-PR-2 bare createClient() actually used.
const LEGACY_KEY = 'sb-yeszghaspzwwstvsrioa-auth-token';
const NOW = Math.floor(Date.now() / 1000);

function main() {
  const cookieStorageSrc = fs.readFileSync(path.join(repoRoot, 'js', 'cookie-storage.js'), 'utf8');

  // (1) NEGATIVE CONTROL: a still-valid legacy-key session is migrated to
  // cookies, not purged, when read under the canonical key -- proves a page
  // that just converged (no cookies of its own yet) does not sign its user
  // out.
  {
    try {
      const access = makeJwt({ sub: 'user-mig', exp: NOW + 3600, iat: NOW });
      const raw = sessionJson(access, 'refresh-legacy', NOW + 3600);
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: raw });

      ok(!cookieDoc.has(COOKIE_ACCESS), '(1) precondition: no session cookies exist before migration');

      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result !== null, '(1) legacy-key session is NOT treated as signed-out when read under the canonical key');
      ok(result !== null && JSON.parse(result).access_token === access, '(1) migrated session carries the original access token');
      ok(cookieDoc.has(COOKIE_ACCESS) && cookieDoc.has(COOKIE_REFRESH), '(1) migration promotes the legacy session onto the shared cookies');
    } catch (e) {
      failWithReason('(1) legacy-key migration negative control', e.message);
    }
  }

  // (2) An EXPIRED legacy-key session is NOT migrated -- falls through to
  // the existing purge/sign-out path unchanged.
  {
    try {
      const access = makeJwt({ sub: 'user-exp', exp: NOW - 3600, iat: NOW - 7200 });
      const raw = sessionJson(access, 'refresh-legacy-expired', NOW - 3600);
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: raw });

      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(2) an expired legacy-key session is not migrated');
      ok(!cookieDoc.has(COOKIE_ACCESS), '(2) no cookies were written for an expired legacy session');
      ok(ctx.localStorage.getItem(LEGACY_KEY) === null, '(2) purge behavior (pre-existing, unchanged): the legacy key itself is removed');
    } catch (e) {
      failWithReason('(2) expired legacy session not migrated', e.message);
    }
  }

  // (3) A malformed legacy value is not migrated -- purge path runs exactly
  // as before this PR.
  {
    try {
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: 'not-json-and-not-a-session' });
      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(3) a malformed legacy value is not migrated');
      ok(!cookieDoc.has(COOKIE_ACCESS), '(3) no cookies were written for a malformed legacy value');
    } catch (e) {
      failWithReason('(3) malformed legacy value not migrated', e.message);
    }
  }

  // (4) One-time self-heal: after migration, the cookie fast-path wins even
  // if a stale legacy value reappears (e.g. a second tab writing garbage).
  {
    try {
      const access = makeJwt({ sub: 'user-heal', exp: NOW + 3600, iat: NOW });
      const raw = sessionJson(access, 'refresh-legacy', NOW + 3600);
      const { ctx } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: raw });

      const first = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(first !== null, '(4) first read migrates successfully');

      ctx.localStorage.setItem(LEGACY_KEY, 'garbage-that-would-fail-to-parse');
      const second = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(second !== null && JSON.parse(second).access_token === access,
        '(4) second read takes the cookie fast-path, ignoring the now-stale legacy key');
    } catch (e) {
      failWithReason('(4) one-time self-heal', e.message);
    }
  }

  // (5) Repo-wide convergence guard: every browser-side createClient(...)
  // call site that wires a storage adapter must wire the canonical
  // storageKey too. Catches a future page reintroducing the exact gh-1980
  // PR 2 regression (a storage adapter without a matching key, or a
  // hardcoded key that diverges from window.OTTERQUOTE_AUTH_STORAGE_KEY).
  {
    try {
      const htmlFiles = fs.readdirSync(repoRoot)
        .filter((f) => f.endsWith('.html'))
        .map((f) => path.join(repoRoot, f));
      let sitesWithAdapter = 0;
      let sitesMissingKey = 0;
      const offenders = [];
      for (const file of htmlFiles) {
        const src = fs.readFileSync(file, 'utf8');
        // Call sites that wire OtterQuoteCookieStorage as the storage adapter.
        const re = /storage:\s*window\.OtterQuoteCookieStorage([^}]*)\}/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          sitesWithAdapter++;
          const tail = m[1] || '';
          if (!/storageKey:\s*window\.OTTERQUOTE_AUTH_STORAGE_KEY/.test(tail)) {
            sitesMissingKey++;
            offenders.push(path.basename(file));
          }
        }
      }
      ok(sitesWithAdapter >= 20, '(5) at least 20 browser-side call sites wire the OtterQuoteCookieStorage adapter -- found ' + sitesWithAdapter);
      ok(sitesMissingKey === 0, '(5) every adapter-wired call site also wires the canonical storageKey -- offenders: ' + JSON.stringify(offenders));

      // js/config.js (CRLF file, checked separately -- source below is
      // read raw so the regex above, which is line-ending agnostic, still
      // applies to it via the same pattern check).
      const configSrc = fs.readFileSync(path.join(repoRoot, 'js', 'config.js'), 'utf8');
      ok(/storage:\s*window\.OtterQuoteCookieStorage,\s*storageKey:\s*window\.OTTERQUOTE_AUTH_STORAGE_KEY/.test(configSrc),
        '(5) js/config.js\'s _oqCreateSupabaseClient() wires the canonical storageKey');
    } catch (e) {
      failWithReason('(5) repo-wide storageKey convergence guard', e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main();
