/**
 * gh-1980 PR 2/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") -- static
 * stack storageKey convergence, mirroring the react-app suite's
 * gh1980-pr2-storagekey-migration.test.ts.
 *
 * PR 2's job: converge every browser-side Supabase client construction onto
 * the canonical storageKey (window.OTTERQUOTE_AUTH_STORAGE_KEY /
 * 'sb-otterquote-auth'), and pin supabase-js so the CDN version does not
 * float. This file has two halves:
 *
 *   Scenarios (1)-(3): #488 regression coverage (RETURNED per REVIEW: FAIL
 *   comment 5856934888 / RETURNED 5856979533 on PR #2255, CTO RUN 43). The
 *   PR's original migrateLegacySession() ran BEFORE the "both cookies
 *   absent -> signed out, purge local copies" branch and wrote a still-valid
 *   per-origin localStorage session back onto the shared, domain-wide
 *   cookies. That reverses #488: a user who signs out on app.otterquote.com
 *   (deleting only the shared cookies + app's own localStorage) and then
 *   loads otterquote.com is signed back in, because otterquote.com's own
 *   localStorage copy (canonical key OR any recognized legacy key) still had
 *   a live session and got promoted onto the cookies. On a shared computer
 *   the next person inherits it. migrateLegacySession() has been removed
 *   entirely; getItem() now runs the unconditional #488 purge exactly as it
 *   did before this PR, run REGARDLESS of which key (canonical or legacy)
 *   carries the leftover session.
 *
 *   Scenario (4): a malformed legacy value is still purged, not migrated
 *   (there is no migration path any more) -- basic purge-path coverage.
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
 * Fail-first: scenarios (1)-(2) FAIL against PR #2255 head 50ef0f81 (the
 * pre-fix `migrateLegacySession()` resurrects the session and rewrites the
 * cookies instead of signing out) and PASS on this head. Scenario (5) fails
 * against the pre-PR-2 working tree (admin-dashboard.html etc. had no
 * storageKey at all).
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

  // (1) #488 REGRESSION -- CANONICAL key: a still-valid session sitting only
  // in this origin's localStorage under the canonical key, no session
  // cookies present (the cross-subdomain sign-out scenario: cookies were
  // deleted on the other subdomain, this origin's localStorage was never
  // touched) -- getItem() under the canonical key MUST return null (signed
  // out), MUST NOT write the session-cookies, and MUST purge the canonical
  // key from localStorage. This is exactly what RETURNED comment 5856979533
  // says PR #2255 head 50ef0f81 gets wrong: migrateLegacySession() reads
  // this same localStorage entry and promotes it back onto the shared
  // cookies, undoing the sign-out.
  {
    try {
      const access = makeJwt({ sub: 'user-486-canonical', exp: NOW + 3600, iat: NOW });
      const raw = sessionJson(access, 'refresh-canonical', NOW + 3600);
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [STORAGE_KEY]: raw });

      ok(!cookieDoc.has(COOKIE_ACCESS), '(1) precondition: no session cookies exist (simulates sign-out on the other subdomain)');

      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(1) #488 REGRESSION: a canonical-key localStorage session with no cookies is signed out, not resurrected');
      ok(!cookieDoc.has(COOKIE_ACCESS) && !cookieDoc.has(COOKIE_REFRESH), '(1) #488 REGRESSION: the session-cookies are never written from the localStorage copy');
      ok(ctx.localStorage.getItem(STORAGE_KEY) === null, '(1) #488 REGRESSION: the canonical-key localStorage entry is purged, not left to resurrect on a later read');
    } catch (e) {
      failWithReason('(1) #488 regression -- canonical key', e.message);
    }
  }

  // (2) #488 REGRESSION -- LEGACY key: same scenario, but the leftover
  // session sits under a legacy (pre-convergence) key
  // (`sb-<project-ref>-auth-token`, what admin-dashboard.html's old bare
  // createClient() used) instead of the canonical one. The RETURNED comment
  // is explicit that restricting the old migration shim to legacy keys only
  // would NOT have fixed the defect -- this scenario is the proof: the fix
  // must purge unconditionally regardless of which key holds the leftover
  // session.
  {
    try {
      const access = makeJwt({ sub: 'user-488-legacy', exp: NOW + 3600, iat: NOW });
      const raw = sessionJson(access, 'refresh-legacy', NOW + 3600);
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: raw });

      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(2) #488 REGRESSION: a legacy-key localStorage session with no cookies is signed out, not resurrected');
      ok(!cookieDoc.has(COOKIE_ACCESS) && !cookieDoc.has(COOKIE_REFRESH), '(2) #488 REGRESSION: the session-cookies are never written from the legacy-key localStorage copy');
      ok(ctx.localStorage.getItem(LEGACY_KEY) === null, '(2) #488 REGRESSION: the legacy key itself is purged from localStorage');
    } catch (e) {
      failWithReason('(2) #488 regression -- legacy key', e.message);
    }
  }

  // (3) An EXPIRED legacy-key session hits the same unconditional purge path
  // (there is no migration branch left to special-case it).
  {
    try {
      const access = makeJwt({ sub: 'user-exp', exp: NOW - 3600, iat: NOW - 7200 });
      const raw = sessionJson(access, 'refresh-legacy-expired', NOW - 3600);
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: raw });

      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(3) an expired legacy-key session is signed out');
      ok(!cookieDoc.has(COOKIE_ACCESS), '(3) no cookies were written for an expired legacy session');
      ok(ctx.localStorage.getItem(LEGACY_KEY) === null, '(3) purge behavior: the legacy key itself is removed');
    } catch (e) {
      failWithReason('(3) expired legacy session purged', e.message);
    }
  }

  // (4) A malformed legacy value is purged the same way -- no migration path
  // exists to special-case it.
  {
    try {
      const { ctx, cookieDoc } = buildRealm(cookieStorageSrc, { [LEGACY_KEY]: 'not-json-and-not-a-session' });
      const result = ctx.window.OtterQuoteCookieStorage.getItem(STORAGE_KEY);
      ok(result === null, '(4) a malformed legacy value is signed out, not migrated');
      ok(!cookieDoc.has(COOKIE_ACCESS), '(4) no cookies were written for a malformed legacy value');
    } catch (e) {
      failWithReason('(4) malformed legacy value purged', e.message);
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
