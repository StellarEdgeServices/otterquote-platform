/**
 * gh-2060 RETURNED item 4 — auth-callback.html's `_oqGetIntent()` staleness.
 *
 * The 5856979653 RETURNED ruling named two static-stack readers that
 * actually ROUTE users and, until this fix, trusted `cs_auth_role` with no
 * age limit: `auth-callback.html:177` (`_oqGetIntent()`, tested here) and
 * `index.html:32,59` (the homepage bounce, see
 * tests/auth-index-bounce-routing.mjs's gh-2060 cases).
 *
 * `js/auth.js`'s `Auth.handleAuthCallback()` (gh-2060 static batch, already
 * fixed) only gates whether the `cs_signup` homeowner profile write fires —
 * it does not change WHERE the user is sent. `_oqGetIntent()` is the reader
 * that actually decides the redirect target on this page, so a stale
 * `cs_auth_role='contractor'` left by an abandoned contractor signup could
 * still misroute a later, unrelated homeowner sign-in to
 * `/contractor-pre-approval.html` even after the js/auth.js fix landed.
 *
 * This test loads the real IIFE out of auth-callback.html (not a
 * reimplementation) and drives it through its `sb.auth.onAuthStateChange`
 * entry point, asserting the ACTUAL redirect target — the same
 * routing-outcome style as tests/auth-index-bounce-routing.mjs.
 *
 * Run: node tests/gh2060-auth-callback-html-staleness.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(REPO_ROOT, 'auth-callback.html'), 'utf8');

// Pull the routing IIFE out of its <script> tag — the block that opens with
// `(function () {\n  'use strict';` and closes `})();` just before
// `</script>` at the end of the file (the second, larger <script> block;
// the first few are library loads / config with no closing IIFE of this
// shape).
const scriptMatch = html.match(/<script>\n\(function \(\) \{\n {2}'use strict';[\s\S]*?\n\}\)\(\);\n<\/script>/);
if (!scriptMatch) {
  throw new Error('Could not locate the routing IIFE in auth-callback.html — has the script tag structure changed?');
}
const routingSrc = scriptMatch[0].replace(/^<script>\n/, '').replace(/\n<\/script>$/, '');

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? (store[k] ?? null) : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

/**
 * Runs the real auth-callback.html routing IIFE against a mock Supabase
 * client + Auth global, fires the SIGNED_IN callback with a fixed session,
 * and returns the first `window.location.href` write (or null if none).
 */
async function runHandle({ csAuthRole, csAuthRoleAt, role = 'homeowner', hasClaim = false, intentUrlParam }) {
  const localStorageStore = {};
  if (csAuthRole !== undefined) localStorageStore.cs_auth_role = csAuthRole;
  if (csAuthRoleAt !== undefined) localStorageStore.cs_auth_role_at = csAuthRoleAt;
  const localStorage = makeStorage(localStorageStore);

  const hrefWrites = [];
  let capturedCallback;

  const sandbox = {
    console,
    setTimeout: () => {}, // neutralize the 30s safety timeout for this test
    Promise,
    URLSearchParams,
    localStorage,
    document: { getElementById: () => ({ style: {} }) },
    gtag: () => {},
    window: {
      location: {
        search: intentUrlParam ? `?intent=${intentUrlParam}` : '',
        get href() { return hrefWrites[hrefWrites.length - 1] ?? ''; },
        set href(v) { hrefWrites.push(v); },
      },
      _oq_has_auth_in_url: false,
    },
    Auth: {
      recordFirstTouchAttribution: async () => {},
      getRole: async () => role,
      _getIsAdmin: async () => false,
    },
  };
  sandbox.window.localStorage = localStorage;

  sandbox.sb = {
    auth: {
      onAuthStateChange: (cb) => { capturedCallback = cb; },
    },
    from: (table) => {
      const q = {
        select() { return q; },
        eq() { return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() {
          if (table === 'claims') {
            return Promise.resolve(hasClaim ? { data: { id: 'claim-1' }, error: null } : { data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
  sandbox.window.sb = sandbox.sb;

  vm.createContext(sandbox);
  vm.runInContext(routingSrc, sandbox, { filename: 'auth-callback.html#routing' });

  assert.ok(typeof capturedCallback === 'function', 'sb.auth.onAuthStateChange callback was never registered');
  await capturedCallback('SIGNED_IN', { user: { id: 'user-gh2060' } });

  return { dest: hrefWrites[0] ?? null, localStorage };
}

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`✗ FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

async function main() {
  // Case 1 (the bug, pre-fix shape) — a STALE, un-timestamped
  // cs_auth_role='contractor' left by an abandoned contractor signup, no
  // contractor DB record for this user (role resolves 'homeowner'), must
  // NOT route to /contractor-pre-approval.html.
  await check(
    'stale untimestamped cs_auth_role=contractor (abandoned signup) does not misroute a fresh homeowner sign-in',
    async () => {
      const { dest } = await runHandle({ csAuthRole: 'contractor', role: 'homeowner', hasClaim: false });
      assert.ok(
        dest && !dest.includes('contractor-pre-approval'),
        `expected routing away from /contractor-pre-approval.html (stale intent must be ignored), got ${JSON.stringify(dest)}`
      );
      assert.ok(dest.includes('trade-selector'), `expected /trade-selector.html for a homeowner with no claim, got ${JSON.stringify(dest)}`);
    }
  );

  // Case 2 — a >24h-stale cs_auth_role_at is treated identically to absent.
  await check(
    '>24h-stale cs_auth_role_at is treated as absent, same as no timestamp at all',
    async () => {
      const { dest } = await runHandle({
        csAuthRole: 'contractor',
        csAuthRoleAt: String(Date.now() - 25 * 60 * 60 * 1000),
        role: 'homeowner',
        hasClaim: false,
      });
      assert.ok(
        dest && !dest.includes('contractor-pre-approval'),
        `>24h-stale cs_auth_role_at should not misroute, got ${JSON.stringify(dest)}`
      );
    }
  );

  // Case 3 (POSITIVE CONTROL) — a FRESH cs_auth_role='contractor' (real
  // magic-link/OAuth round trip) with no contractor DB record yet (brand
  // new signup) must still route to /contractor-pre-approval.html.
  await check(
    'POSITIVE CONTROL: a FRESH cs_auth_role=contractor still routes to /contractor-pre-approval.html',
    async () => {
      const { dest } = await runHandle({
        csAuthRole: 'contractor',
        csAuthRoleAt: String(Date.now() - 5 * 60 * 1000),
        role: 'homeowner', // no contractor DB record yet — mid-signup
        hasClaim: false,
      });
      assert.ok(
        dest && dest.includes('contractor-pre-approval'),
        `expected /contractor-pre-approval.html for a fresh contractor intent, got ${JSON.stringify(dest)}`
      );
    }
  );

  // Case 4 — a live contractor DB record ALWAYS wins regardless of intent
  // staleness (unchanged precedence — role==='contractor' branch runs
  // before the intent==='contractor' branch).
  await check(
    'a live contractor DB record still routes to /contractor-dashboard.html regardless of a stale homeowner intent',
    async () => {
      const { dest } = await runHandle({
        csAuthRole: 'homeowner',
        csAuthRoleAt: String(Date.now() - 25 * 60 * 60 * 1000),
        role: 'contractor',
      });
      assert.ok(
        dest && dest.includes('contractor-dashboard'),
        `expected /contractor-dashboard.html (DB record wins), got ${JSON.stringify(dest)}`
      );
    }
  );

  // Case 5 — cs_auth_role and cs_auth_role_at are both cleared after
  // _oqGetIntent() runs, one-shot, regardless of whether the value was
  // trusted (this is the RETURNED-item-4 counterpart to items 2/5 for the
  // React and js/auth.js readers).
  await check(
    'cs_auth_role and cs_auth_role_at are cleared from localStorage after _oqGetIntent() runs (stale branch)',
    async () => {
      const { localStorage } = await runHandle({ csAuthRole: 'contractor', role: 'homeowner', hasClaim: false });
      assert.equal(localStorage.getItem('cs_auth_role'), null, 'cs_auth_role must be cleared after read');
      assert.equal(localStorage.getItem('cs_auth_role_at'), null, 'cs_auth_role_at must be cleared after read');
    }
  );

  await check(
    'cs_auth_role and cs_auth_role_at are cleared from localStorage after _oqGetIntent() runs (trusted/fresh branch)',
    async () => {
      const { localStorage } = await runHandle({
        csAuthRole: 'contractor',
        csAuthRoleAt: String(Date.now() - 5 * 60 * 1000),
        role: 'homeowner',
      });
      assert.equal(localStorage.getItem('cs_auth_role'), null, 'cs_auth_role must be cleared after read');
      assert.equal(localStorage.getItem('cs_auth_role_at'), null, 'cs_auth_role_at must be cleared after read');
    }
  );

  // Case 6 — the URL ?intent= param still wins outright and is unaffected
  // by the TTL gate (it never touches localStorage at all).
  await check(
    'URL ?intent=contractor still wins immediately, independent of any localStorage TTL',
    async () => {
      const { dest } = await runHandle({ intentUrlParam: 'contractor', role: 'homeowner', hasClaim: false });
      assert.ok(
        dest && dest.includes('contractor-pre-approval'),
        `expected ?intent=contractor to route to /contractor-pre-approval.html, got ${JSON.stringify(dest)}`
      );
    }
  );

  if (failures > 0) {
    console.log(`\n✗ ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ All gh-2060 auth-callback.html _oqGetIntent staleness cases pass.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
