/**
 * Regression test for #807 — js/auth.js partner-surface single source of truth.
 *
 * Root cause: requireAuth() defined "is this a partner surface" as
 * /(^|\/)(partner-|ref-|recruit|refer-a-friend)/ against the full pathname;
 * redirectToDashboard()'s #783 guard defined it as
 * `indexOf('partner-') === 0` against the trailing filename only. The two
 * definitions silently diverged: ref-*, recruit*, and refer-a-friend* pages
 * were partner surfaces by requireAuth()'s definition but NOT by
 * redirectToDashboard()'s — so a signed-in partner landing on one of those
 * pages could be bounced into the homeowner intake flow instead of staying
 * put, the same defect class as #643 but on a different set of pages.
 *
 * Fixed by extracting one shared `_isPartnerSurfaceFile()` helper, used by
 * requireAuth(), redirectToDashboard(), and its cs_redirect staleness check.
 * `scripts/check-partner-surface-single-source.py` guards the source
 * statically (one definition, both call sites use it); this test exercises
 * the real functions' actual behavior for all four surface families plus
 * the homeowner/contractor control cases (AC #5-10).
 *
 * This is code-level verification against the real js/auth.js running in a
 * vm context, on real pathnames for each surface family — it is NOT a
 * live-browser or physical-device test (per #807 AC #13, an E2E green run
 * is explicitly not accepted as evidence here; this test replaces the E2E
 * gap with an assertion the E2E suite still doesn't provide, but a
 * device-level check remains undone).
 *
 * Run: node tests/auth-partner-surface-single-source.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

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

  // gh-909 (D-182 v113, 2026-08-19): getRole() now reads a single
  // `resolved_user_role` row instead of querying contractors/
  // referral_agents/profiles directly, so that is what these fixtures need
  // to seed for getRole()-driven behavior (requireAuth(), redirectToDashboard()
  // role branches). The precedence itself (contractor -> active partner ->
  // owns-a-claim -> profiles.role -> 'homeowner' default) is server-side and
  // already branch-tested (v113 migration pre-flight doc) — this mock just
  // reproduces it from the same fixture inputs so existing test cases don't
  // need to change shape. `contractors`/`referral_agents`/`profiles` mocks
  // are kept for requireAuth()'s gh-959 interim guard, which queries those
  // tables directly and is UNCHANGED by this migration. `claims` is kept
  // for redirectToDashboard()'s own separate existing-claim routing check
  // (also unchanged — it does not go through getRole()/the view).
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
    console,
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

const PARTNER_FAMILY_PAGES = [
  ['partner-dashboard.html', 'partner-'],
  ['ref-insurance.html', 'ref-'],
  ['recruit.html', 'recruit'],
  ['refer-a-friend.html', 'refer-a-friend'],
];

async function main() {
  // ── requireAuth(): unauthenticated bounce target (AC #6-8, plus partner- control) ──
  for (const [file, family] of PARTNER_FAMILY_PAGES) {
    const sandbox = makeSandbox({ pathname: '/' + file, user: null });
    await sandbox.window.Auth.requireAuth();
    assert.equal(
      sandbox._locationWrites[0], '/partner-login.html',
      `requireAuth() on /${file} (${family} family): expected bounce to /partner-login.html, got ${sandbox._locationWrites[0]}`
    );
  }
  console.log('✓ PASS: requireAuth() routes all 4 partner-surface families (partner-/ref-/recruit/refer-a-friend) to /partner-login.html when signed out');

  {
    const sandbox = makeSandbox({ pathname: '/dashboard.html', user: null });
    await sandbox.window.Auth.requireAuth();
    assert.equal(sandbox._locationWrites[0], '/get-started.html');
  }
  console.log('✓ PASS: requireAuth() control (non-partner page) still bounces to /get-started.html when signed out');

  // ── redirectToDashboard(): signed-in partner stays put on all 4 families (AC #5-8) ──
  for (const [file, family] of PARTNER_FAMILY_PAGES) {
    const sandbox = makeSandbox({
      pathname: '/' + file,
      user: { id: 'u1' },
      contractorRow: { id: 'c1' }, // dual-role, like dustinstohler1@gmail.com — the hardest case
      agentRow: { agent_type: 'home_inspector' },
      profileRole: 'contractor',
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(
      sandbox._locationWrites.length, 0,
      `redirectToDashboard() on /${file} (${family} family): expected no redirect (stay put), got ${JSON.stringify(sandbox._locationWrites)}`
    );
  }
  console.log('✓ PASS: redirectToDashboard() leaves a signed-in (dual-role) partner in place on all 4 partner-surface families');

  // ── redirectToDashboard(): homeowner/contractor routing unchanged on a non-partner page (AC #9) ──
  {
    const sandbox = makeSandbox({
      pathname: '/get-started.html', user: { id: 'u2' },
      contractorRow: { id: 'c2' }, agentRow: null, profileRole: 'contractor',
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(sandbox._locationWrites[0], '/contractor-dashboard.html');
  }
  console.log('✓ PASS: redirectToDashboard() control — contractor still routes to /contractor-dashboard.html');

  {
    const sandbox = makeSandbox({
      pathname: '/get-started.html', user: { id: 'u3' },
      contractorRow: null, agentRow: null, profileRole: 'homeowner',
      claimRow: { id: 'claim1', status: 'bidding' },
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(sandbox._locationWrites[0], '/dashboard.html');
  }
  console.log('✓ PASS: redirectToDashboard() control — homeowner with a claim still routes to /dashboard.html');

  {
    const sandbox = makeSandbox({
      pathname: '/get-started.html', user: { id: 'u4' },
      contractorRow: null, agentRow: null, profileRole: 'homeowner',
      claimRow: null, sessionStorageInitial: {},
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(sandbox._locationWrites[0], '/trade-selector.html');
  }
  console.log('✓ PASS: redirectToDashboard() control — new homeowner (no claim) still routes to /trade-selector.html');

  // ── redirectToDashboard(): gh-851 — partner-only account off a partner page ──
  // Before the fix, this function had no partner branch at all: every
  // partner agent_type fell into the else and routed to trade-selector/
  // dashboard.html (homeowner intake). Only the onPartnerPage early-return
  // above saved a partner who was already ON a partner page; this is the
  // case that wasn't saved by that guard.
  {
    const sandbox = makeSandbox({
      pathname: '/get-started.html', user: { id: 'u7' },
      contractorRow: null, agentRow: { agent_type: 're_agent' }, profileRole: 'homeowner',
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(
      sandbox._locationWrites[0], '/partner-dashboard.html',
      `partner-only account reaching redirectToDashboard() off a non-partner page: expected /partner-dashboard.html, got ${JSON.stringify(sandbox._locationWrites)}`
    );
  }
  console.log('✓ PASS: gh-851 — redirectToDashboard() now routes a partner-only account to /partner-dashboard.html even off a partner page');

  // ── cs_redirect widened check (AC #10) ──
  // A saved ref-* redirect must be HONORED on a partner-family page — it is
  // NOT stale-cross-surface under the widened (shared) definition, even
  // though it isn't literally 'partner-'.
  {
    const sandbox = makeSandbox({
      pathname: '/partner-dashboard.html', user: { id: 'u5' },
      contractorRow: { id: 'c5' }, agentRow: { agent_type: 're_agent' }, profileRole: 'contractor',
      sessionStorageInitial: { cs_redirect: '/ref-insurance.html' },
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(
      sandbox._locationWrites[0], '/ref-insurance.html',
      `expected the saved ref-* cs_redirect to be honored (not discarded as stale-cross-surface), got ${JSON.stringify(sandbox._locationWrites)}`
    );
  }
  console.log('✓ PASS: cs_redirect to a ref-* page is honored (not discarded) when landing on a partner-family page');

  // A saved CONTRACTOR redirect on a partner-family page IS still discarded
  // as stale-cross-surface (the #817 scenario this guard exists for).
  {
    const sandbox = makeSandbox({
      pathname: '/partner-dashboard.html', user: { id: 'u6' },
      contractorRow: { id: 'c6' }, agentRow: { agent_type: 're_agent' }, profileRole: 'contractor',
      sessionStorageInitial: { cs_redirect: '/contractor-dashboard.html' },
    });
    await sandbox.window.Auth.redirectToDashboard();
    assert.equal(
      sandbox._locationWrites.length, 0,
      `expected the stale contractor cs_redirect to be discarded (stay on partner-dashboard.html), got ${JSON.stringify(sandbox._locationWrites)}`
    );
  }
  console.log('✓ PASS: cs_redirect to a non-partner page is still discarded as stale-cross-surface (gh-817 regression guard intact)');

  console.log('\n✓ All partner-surface single-source-of-truth cases pass.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
