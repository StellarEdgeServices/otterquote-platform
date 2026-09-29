/**
 * gh-2060 static-stack negative control — cs_auth_role staleness.
 *
 * PR #2253 (React stack) fixed the same bug class in
 * app/auth-callback/page.tsx: a `cs_auth_role` breadcrumb, written right
 * before a login/signup entry point redirects into the Supabase auth flow,
 * had no expiry and was cleared only on one branch — so a value left behind
 * by an ABANDONED signup on a shared browser could silently attach to a
 * completely unrelated, later sign-in.
 *
 * This is the static-stack counterpart, at `js/auth.js:969`
 * (`Auth.handleAuthCallback()`). Pre-fix:
 *
 *   let role = localStorage.getItem('cs_auth_role') || sessionStorage.getItem('cs_auth_role');
 *   if (!role && sb) { ...query the contractors table... }
 *
 * `!role` short-circuits the live DB check the instant ANY stored value
 * exists — stale or not. A visitor who abandoned a contractor signup on
 * this browser (localStorage `cs_auth_role='contractor'` written, never
 * cleared because they never completed auth) and later signs in as an
 * unrelated HOMEOWNER through a path that doesn't re-set the key (e.g. a
 * Google OAuth redirect landing straight on this handler) has that stale
 * value read as THIS session's role. Concretely: that skips the
 * `if (signupData && role !== 'contractor')` branch further down, so the
 * new homeowner's real name/phone/address from `cs_signup` is silently
 * NEVER written to their profile.
 *
 * The fix (mirroring the React fix's key names, since both stacks share the
 * same browser storage on the same origin): a `cs_auth_role_at` timestamp is
 * written alongside every `cs_auth_role` write; the reader treats a missing
 * or >24h-old timestamp as absent, always clears both keys on read (one-
 * shot), and always runs the live contractors-table check — a definitive DB
 * answer wins over a trusted stored value in either direction.
 *
 * NEGATIVE CONTROL — this file is written to be run against BOTH the
 * pre-fix and post-fix `js/auth.js`:
 *   RED (pre-fix):  `git show 3b96af4eba8d12eba482f0b7a420dac32f72367f:js/auth.js > /tmp/auth-prefix.js`
 *                    then `node tests/gh2060-static-cs-auth-role-staleness.mjs /tmp/auth-prefix.js`
 *                    (the PR #2253 tip, before this fix) — Case 1 FAILS.
 *   GREEN (post-fix): `node tests/gh2060-static-cs-auth-role-staleness.mjs`
 *                    (current working-tree js/auth.js, no arg) — all cases PASS.
 * Raw output of both runs is pasted in the PR body / HANDOFF-LIVE comment.
 *
 * Run: node tests/gh2060-static-cs-auth-role-staleness.mjs [path/to/auth.js]
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'js', 'auth.js');
const authSrc = fs.readFileSync(authPath, 'utf8');

/** A minimal, real-enough in-memory Storage implementation. */
function makeStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
}

/**
 * Build a fresh vm sandbox running the real js/auth.js source, with:
 *  - real-enough localStorage/sessionStorage (bare globals, as the source
 *    references them — not window.localStorage)
 *  - a mock `sb` (bare global AND window.sb, since call sites in this file
 *    use the bare identifier) whose `contractors` table answers
 *    `hasContractorRecord`, and whose `resolved_user_role` / `claims` /
 *    `profiles` tables are wired just enough for handleAuthCallback() to run
 *    to completion via redirectToDashboard() without throwing.
 *  - Auth.getUser() overridden to resolve a fixed user (no live network).
 * Returns the sandbox plus a `calls` object recording the one thing this
 * test cares about: whether — and with what — the homeowner's profile got
 * upserted.
 */
function makeSandbox({ hasContractorRecord }) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const calls = { profileUpsert: null };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    localStorage,
    sessionStorage,
    document: { cookie: '' },
    navigator: { userAgent: 'node-test' },
    window: {
      location: { pathname: '/auth-callback.html', href: '' },
      OtterQuoteReferral: undefined,
    },
  };

  function tableQuery(table) {
    const q = {
      select() { return q; },
      eq() { return q; },
      order() { return q; },
      limit() { return q; },
      upsert(payload) {
        if (table === 'profiles') calls.profileUpsert = payload;
        return q;
      },
      single() {
        if (table === 'contractors') {
          return hasContractorRecord
            ? Promise.resolve({ data: { id: 'contractor-1' }, error: null })
            : Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        }
        if (table === 'resolved_user_role') {
          return Promise.resolve({
            data: { derived_role: hasContractorRecord ? 'contractor' : 'homeowner' },
            error: null,
          });
        }
        if (table === 'claims') {
          return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        }
        if (table === 'profiles') {
          return Promise.resolve({ data: { id: 'user-gh2060', ...(calls.profileUpsert || {}) }, error: null });
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    return q;
  }

  sandbox.sb = {
    from: (table) => tableQuery(table),
    rpc: (_name, _args) => Promise.resolve({ data: { claimed: false }, error: null }),
    auth: { signOut: async () => ({ error: null }) },
  };
  sandbox.window.sb = sandbox.sb;

  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });

  sandbox.window.Auth.getUser = async () => ({ id: 'user-gh2060' });
  sandbox.__calls = calls; // exposed so tests can read it after running handleAuthCallback()

  return { sandbox, localStorage, sessionStorage, calls };
}

const homeownerSignupData = JSON.stringify({
  first_name: 'Jamie',
  last_name: 'Rivera',
  phone: '555-0100',
  address: '12 Otter Way',
  role: 'homeowner',
});

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
  // Case 1 (the bug) — a STALE, un-timestamped cs_auth_role='contractor'
  // left by an abandoned contractor signup, where no contractor DB record
  // exists for THIS user, must not suppress the new homeowner's profile
  // write from cs_signup.
  await check(
    'stale untimestamped cs_auth_role=contractor (abandoned signup, no DB record) does not swallow a fresh homeowner\'s signup profile write',
    async () => {
      const { sandbox, localStorage, calls } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      // Deliberately NO cs_auth_role_at — this is exactly the pre-fix
      // breadcrumb shape (a value that predates this fix, or was written by
      // an abandoned flow long ago) and must be treated as absent/stale.
      localStorage.setItem('cs_signup', homeownerSignupData);

      await sandbox.window.Auth.handleAuthCallback();
      assert.notEqual(
        calls.profileUpsert, null,
        'expected the homeowner profile to be upserted with cs_signup data, but it was never called ' +
        '(the stale cs_auth_role="contractor" breadcrumb suppressed it)'
      );
      assert.equal(calls.profileUpsert.full_name, 'Jamie Rivera');
    }
  );

  // Case 2 — same stale value, but with a >24h-old cs_auth_role_at. Must be
  // treated identically to "absent" (an old timestamp is not a fresh
  // breadcrumb).
  await check(
    '>24h-stale cs_auth_role_at is treated as absent, same as no timestamp at all',
    async () => {
      const { sandbox, localStorage, calls } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      localStorage.setItem('cs_auth_role_at', String(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago
      localStorage.setItem('cs_signup', homeownerSignupData);

      await sandbox.window.Auth.handleAuthCallback();
      assert.notEqual(
        calls.profileUpsert, null,
        '>24h-stale cs_auth_role_at should not suppress the homeowner profile write'
      );
    }
  );

  // Case 3 (positive control) — a FRESH cs_auth_role='contractor', just
  // written by this same session's contractor login, where a contractor DB
  // record legitimately does NOT exist yet (brand-new signup, record not
  // created until later in this same handler) must still resolve
  // role='contractor' and therefore correctly SKIP the homeowner cs_signup
  // profile write, so the fix does not break the real contractor flow.
  await check(
    'fresh (just-written) cs_auth_role=contractor still resolves contractor and skips the homeowner profile write',
    async () => {
      const { sandbox, localStorage, calls } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      localStorage.setItem('cs_auth_role_at', String(Date.now()));
      localStorage.setItem('cs_signup', homeownerSignupData);

      await sandbox.window.Auth.handleAuthCallback();
      assert.equal(
        calls.profileUpsert, null,
        'a fresh, just-written cs_auth_role=contractor should still resolve as contractor ' +
        '(no contractor DB record yet is expected mid-signup) and skip the homeowner profile write'
      );
    }
  );

  // Case 4 — a STALE stored 'homeowner' breadcrumb must not shadow a real,
  // live contractor DB record either: once the breadcrumb is expired it is
  // treated as absent, the DB check runs, and the DB wins.
  await check(
    'a live contractor DB record wins once a stale stored cs_auth_role=homeowner has expired',
    async () => {
      const { sandbox, localStorage, calls } = makeSandbox({ hasContractorRecord: true });
      localStorage.setItem('cs_auth_role', 'homeowner');
      localStorage.setItem('cs_auth_role_at', String(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago
      localStorage.setItem('cs_signup', homeownerSignupData);

      await sandbox.window.Auth.handleAuthCallback();
      assert.equal(
        calls.profileUpsert, null,
        'a real contractor DB record exists and the stored "homeowner" breadcrumb is expired; ' +
        'the homeowner cs_signup profile write must not fire (role !== "contractor" guard)'
      );
    }
  );

  // Case 5 — both keys are cleared on read, one-shot, regardless of outcome.
  await check(
    'cs_auth_role and cs_auth_role_at are cleared from localStorage after handleAuthCallback() runs',
    async () => {
      const { sandbox, localStorage } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      localStorage.setItem('cs_auth_role_at', String(Date.now()));

      await sandbox.window.Auth.handleAuthCallback();
      assert.equal(localStorage.getItem('cs_auth_role'), null, 'cs_auth_role must be cleared after read');
      assert.equal(localStorage.getItem('cs_auth_role_at'), null, 'cs_auth_role_at must be cleared after read');
    }
  );

  // Case 6 (gh-2060 round-4 hardening 2) — a FUTURE-dated cs_auth_role_at
  // (negative age) used to pass the `<= TTL` check and be trusted forever.
  await check(
    'a future-dated cs_auth_role_at is treated as absent (negative age is not "fresh")',
    async () => {
      const { sandbox, localStorage, calls } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      localStorage.setItem('cs_auth_role_at', String(Date.now() + 365 * 24 * 60 * 60 * 1000)); // +1y
      localStorage.setItem('cs_signup', homeownerSignupData);

      await sandbox.window.Auth.handleAuthCallback();
      assert.notEqual(
        calls.profileUpsert, null,
        'a future-dated cs_auth_role_at was trusted as a fresh breadcrumb and suppressed the homeowner profile write'
      );
    }
  );

  // Case 7 (gh-2060 round-4 hardening 1) — sign-out must not leave an
  // unconsumed breadcrumb (e.g. an abandoned magic-link request) behind for
  // the next user of a shared browser.
  await check(
    'Auth.signOut() clears cs_auth_role and cs_auth_role_at from localStorage and sessionStorage',
    async () => {
      const { sandbox, localStorage, sessionStorage } = makeSandbox({ hasContractorRecord: false });
      localStorage.setItem('cs_auth_role', 'contractor');
      localStorage.setItem('cs_auth_role_at', String(Date.now()));
      sessionStorage.setItem('cs_auth_role', 'contractor');
      sessionStorage.setItem('cs_auth_role_at', String(Date.now()));

      await sandbox.window.Auth.signOut();
      assert.equal(localStorage.getItem('cs_auth_role'), null, 'localStorage cs_auth_role survived sign-out');
      assert.equal(localStorage.getItem('cs_auth_role_at'), null, 'localStorage cs_auth_role_at survived sign-out');
      assert.equal(sessionStorage.getItem('cs_auth_role'), null, 'sessionStorage cs_auth_role survived sign-out');
      assert.equal(sessionStorage.getItem('cs_auth_role_at'), null, 'sessionStorage cs_auth_role_at survived sign-out');
    }
  );

  if (failures > 0) {
    console.log(`\n✗ ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ All gh-2060 static-stack cs_auth_role staleness cases pass.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
