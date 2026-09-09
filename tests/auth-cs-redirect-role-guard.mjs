/**
 * Regression test for gh-1412 / #1476 — js/auth.js cs_redirect role guard.
 *
 * Root cause: requireAuth() stamps `sessionStorage.cs_redirect =
 * window.location.pathname` on ANY unauthenticated hit of ANY auth-gated page
 * (js/auth.js, the sole writer). redirectToDashboard() then replayed that saved
 * path BEFORE any role check, guarded only by gh-817's `staleCrossSurface` test,
 * which fires only when the user is ALREADY on a partner surface. So one
 * logged-out visit to /contractor-dashboard.html left that path in the tab's
 * sessionStorage and the next login replayed it verbatim — whatever the user's
 * role. login.html's password path (gh-1274) never touches auth-callback.html,
 * so none of the #1476/PR #1489 auth-callback routing fixes cover it.
 *
 * Reported against dustin@otterquote.com, whose account resolves cleanly to
 * 'homeowner' (zero contractors rows) yet landed on the contractor surface.
 *
 * WHY THE GUARD IS CONTRACTOR-ONLY. PR #1914's first revision also role-checked
 * partner-surface targets, and REVIEW: FAIL caught it breaking
 * tests/auth-partner-surface-single-source.mjs. getRole() resolves a single
 * scalar and is contractor-first, so a DUAL-ROLE account (contractor record +
 * referral_agents record) resolves to 'contractor', and
 * `!PARTNER_ROLES.includes(role)` read as "the role disagrees" when the truth was
 * "this API cannot represent partner agreement for this user" — discarding a
 * legitimate partner deep link and then hitting the onPartnerPage early-return,
 * stranding the user with no navigation at all. 'contractor' is the one answer
 * getRole() gives authoritatively, so it is the only arm the guard may have.
 * Case 5 below is that exact dual-role case, pinned so the arm cannot come back.
 *
 * WHY A LIST AND NOT A SUBSTRING. The same review caught
 * `pathname.indexOf('contractor') !== -1` discarding a homeowner's legitimate
 * link to contractor-about.html, which calls bare `requireAuth()` (any role).
 * Case 4 pins that. Section B re-derives the gated set from the HTML on every run
 * so js/auth.js's CONTRACTOR_GATED_FILES cannot silently drift from the real
 * gates.
 *
 * This is code-level verification against the real js/auth.js running in a vm
 * context. It is NOT a live-browser test: the reported symptom was never
 * reproduced in the affected browser session, so this pins the mechanism, not
 * the user's full experience.
 *
 * Run: node tests/auth-cs-redirect-role-guard.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const authSrc = fs.readFileSync(path.join(REPO_ROOT, 'js', 'auth.js'), 'utf8');

function makeSessionStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

function makeSandbox({ pathname, user, contractorRow, agentRow, profileRole, sessionStorageInitial, claimRow }) {
  const locationWrites = [];
  const location = {
    pathname,
    get href() { return pathname; },
    set href(v) { locationWrites.push(v); },
  };

  // Mirrors the server-side resolved_user_role precedence
  // (contractor -> active partner -> owns-a-claim -> profiles.role -> homeowner),
  // same shape as tests/auth-partner-surface-single-source.mjs uses.
  function resolvedRoleFor() {
    if (contractorRow) return 'contractor';
    if (agentRow && agentRow.agent_type) return agentRow.agent_type;
    if (claimRow) return 'homeowner';
    return profileRole ?? 'homeowner';
  }

  function tableQuery(table) {
    return {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit() { return this; },
      single() {
        if (table === 'resolved_user_role') {
          return Promise.resolve({ data: { derived_role: resolvedRoleFor() }, error: null });
        }
        if (table === 'contractors') {
          return Promise.resolve(
            contractorRow ? { data: contractorRow, error: null } : { data: null, error: { code: 'PGRST116' } }
          );
        }
        if (table === 'referral_agents') {
          return Promise.resolve(
            agentRow ? { data: agentRow, error: null } : { data: null, error: { code: 'PGRST116' } }
          );
        }
        if (table === 'profiles') {
          return Promise.resolve({ data: { role: profileRole }, error: null });
        }
        if (table === 'claims') {
          return Promise.resolve(
            claimRow ? { data: claimRow, error: null } : { data: null, error: { code: 'PGRST116' } }
          );
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
  }

  const sandbox = {
    window: { location },
    console: { warn() {}, log() {}, error() {} },
    setTimeout,
    Promise,
    sessionStorage: makeSessionStorage(sessionStorageInitial),
    sb: { from: (table) => tableQuery(table) },
  };
  sandbox.window.sb = sandbox.sb;
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
  sandbox.window.Auth.getUser = async () => user;
  sandbox._locationWrites = locationWrites;
  return sandbox;
}

const USER = { id: 'bd8c0b28-eaff-457a-9b60-bd18a321c09e' };

// [name, fixture, saved cs_redirect, expected FIRST navigation (null = none)]
const CASES = [
  [
    'THE BUG: homeowner with a stale contractor-gated cs_redirect is NOT sent to the contractor surface',
    { pathname: '/login.html', user: USER, profileRole: 'homeowner' },
    '/contractor-dashboard.html',
    '/trade-selector.html',
  ],
  [
    'no regression: a real contractor IS still replayed to the contractor surface',
    { pathname: '/login.html', user: USER, contractorRow: { id: 'c1' } },
    '/contractor-dashboard.html',
    '/contractor-dashboard.html',
  ],
  [
    'no regression: a homeowner-surface cs_redirect is replayed untouched',
    { pathname: '/login.html', user: USER, profileRole: 'homeowner', claimRow: { id: 'x', status: 'active' } },
    '/dashboard.html',
    '/dashboard.html',
  ],
  [
    'REVIEW #1914 row 6: contractor-about.html is any-role (bare requireAuth()), so a homeowner keeps its deep link',
    { pathname: '/login.html', user: USER, profileRole: 'homeowner' },
    '/contractor-about.html',
    '/contractor-about.html',
  ],
  [
    'REVIEW #1914 BLOCKER 2: a DUAL-ROLE partner keeps their partner deep link (getRole() says contractor)',
    {
      pathname: '/partner-dashboard.html',
      user: USER,
      contractorRow: { id: 'c5' },
      agentRow: { agent_type: 're_agent' },
    },
    '/ref-insurance.html',
    '/ref-insurance.html',
  ],
  [
    'off-site belt: a protocol-relative cs_redirect is discarded, never navigated to',
    { pathname: '/login.html', user: USER, profileRole: 'homeowner' },
    '//evil.example/contractor-dashboard.html',
    '/trade-selector.html',
  ],
  [
    'off-site belt: a backslash-smuggled cs_redirect is discarded',
    { pathname: '/login.html', user: USER, profileRole: 'homeowner' },
    '/\\evil.example/dashboard.html',
    '/trade-selector.html',
  ],
];

async function main() {
  let failures = 0;

  // ── Section A: behaviour ──────────────────────────────────────────────────
  for (const [name, fixture, saved, expected] of CASES) {
    const sandbox = makeSandbox({ ...fixture, sessionStorageInitial: { cs_redirect: saved } });
    await sandbox.window.Auth.redirectToDashboard();
    const got = sandbox._locationWrites[0] ?? null;
    try {
      assert.equal(got, expected);
      console.log(`✓ PASS: ${name}`);
    } catch {
      failures++;
      console.error(`✗ FAIL: ${name}\n    cs_redirect=${saved}\n    expected first navigation: ${expected}\n    got: ${got}`);
    }
  }

  // Fail-open on an unresolved role (gh-959 transient): getRole() returning null
  // must NOT discard, or a legitimate deep link is stranded by a flaky lookup.
  {
    const sandbox = makeSandbox({
      pathname: '/login.html',
      user: USER,
      sessionStorageInitial: { cs_redirect: '/contractor-dashboard.html' },
    });
    sandbox.window.Auth.getRole = async () => null;
    await sandbox.window.Auth.redirectToDashboard();
    const got = sandbox._locationWrites[0] ?? null;
    try {
      assert.equal(got, '/contractor-dashboard.html');
      console.log('✓ PASS: fail-open — an unresolved role replays the saved target rather than stranding it');
    } catch {
      failures++;
      console.error(`✗ FAIL: fail-open on unresolved role — expected /contractor-dashboard.html, got ${got}`);
    }
  }

  // ── Section B: CONTRACTOR_GATED_FILES must match the real gates ───────────
  // Re-derived from the HTML every run. A contractor page that starts calling
  // requireAuth('contractor') without being added to the list would silently
  // reopen the bug for that page; one listed that is not actually gated would
  // silently eat a legitimate link.
  {
    const sandbox = makeSandbox({ pathname: '/login.html', user: USER });
    const declared = [...(sandbox.CONTRACTOR_GATED_FILES ?? [])].sort();

    const actual = fs.readdirSync(REPO_ROOT)
      .filter((f) => f.startsWith('contractor-') && f.endsWith('.html'))
      .filter((f) => /requireAuth\(\s*['"]contractor['"]\s*\)/.test(
        fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')
      ))
      .sort();

    try {
      assert.deepEqual(declared, actual);
      console.log(`✓ PASS: CONTRACTOR_GATED_FILES matches the ${actual.length} pages that call requireAuth('contractor')`);
    } catch {
      failures++;
      const missing = actual.filter((f) => !declared.includes(f));
      const extra = declared.filter((f) => !actual.includes(f));
      console.error('✗ FAIL: CONTRACTOR_GATED_FILES has drifted from the real gates in the HTML.');
      if (missing.length) console.error(`    gated but NOT listed (reopens gh-1412 for these): ${missing.join(', ')}`);
      if (extra.length) console.error(`    listed but NOT gated (will eat legitimate deep links): ${extra.join(', ')}`);
      console.error('    Fix js/auth.js CONTRACTOR_GATED_FILES to match.');
    }
  }

  if (failures) {
    console.error(`\n${failures} cs_redirect role-guard case(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ All cs_redirect role-guard cases pass.');
}

main().catch((e) => { console.error(e); process.exit(1); });
