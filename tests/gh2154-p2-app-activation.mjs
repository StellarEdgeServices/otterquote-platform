/**
 * gh-2154 P-2 -- first signed-in standalone launch of the installed partner
 * app calls the new `record_partner_app_activation` RPC exactly once,
 * fails silently, and never fires when signed out or not running standalone.
 *
 * Written FIRST, per #2121 rule 2: at the time this file was authored,
 * neither partner-app.html nor partner-dashboard.html called any such RPC,
 * so every "RPC called" assertion below fails against the unchanged files
 * (see the PR description for that failing run's raw output).
 *
 * Extracts the REAL source (never a hand-retyped copy) out of
 * partner-app.html and partner-dashboard.html by anchor text, at test-run
 * time, and runs it in a `vm` context behind minimal Auth/CONFIG/localStorage
 * stand-ins -- same technique as tests/gh2096-abandon-beacon-restore.mjs and
 * tests/gh2122-arm-f.mjs.
 *
 * Run: node tests/gh2154-p2-app-activation.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed (or an
 * extraction anchor was not found, e.g. because the source moved).
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found for ' + label + ': ' + JSON.stringify(startAnchor));
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found for ' + label + ': ' + JSON.stringify(endAnchor));
  return src.slice(startIdx, endIdx);
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

// ── partner-app.html ────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'partner-app.html'), 'utf8');
  const block = extractBetween(
    src,
    'function isStandalone() {',
    '\n            // The two "How to install"',
    'partner-app.html isStandalone()/recordAppActivationIfSignedIn()'
  );

  function run({ hasPartnerSession, userId, rpcImpl, preflaggedFor, ls: sharedLs } = {}) {
    const ls = sharedLs || makeLocalStorage();
    if (preflaggedFor) ls.setItem('oq_partner_app_activated:' + preflaggedFor, '1');
    const rpcCalls = [];
    const client = {
      rpc: (name) => {
        rpcCalls.push(name);
        return (rpcImpl || (() => Promise.resolve({ data: true, error: null })))();
      },
    };
    const Auth = {
      hasPartnerSession: () => Promise.resolve(!!hasPartnerSession),
      getUser: () => Promise.resolve(userId ? { id: userId } : null),
    };
    const CONFIG = {
      whenReady: (cb) => cb(client),
    };
    const ctx = {
      window: { localStorage: ls },
      Auth,
      CONFIG,
      Promise,
      console,
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext('function isStandalone() {}\n' + block, ctx); // isStandalone() itself is unused by recordAppActivationIfSignedIn
    return { ctx, rpcCalls, ls };
  }

  async function settle() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

  {
    const { ctx, rpcCalls, ls } = run({ hasPartnerSession: true, userId: 'user-1' });
    ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(rpcCalls.length === 1 && rpcCalls[0] === 'record_partner_app_activation', 'partner-app.html: standalone + signed-in calls record_partner_app_activation exactly once');
    ok(ls.getItem('oq_partner_app_activated:user-1') === '1', 'partner-app.html: the per-user localStorage flag is set after a successful call');
  }
  {
    const { ctx, rpcCalls } = run({ hasPartnerSession: false, userId: 'user-1' });
    ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(rpcCalls.length === 0, 'partner-app.html NEGATIVE CONTROL: standalone + signed-out never calls the RPC');
  }
  {
    // RPC rejection must not throw, and must not mark the flag as recorded.
    const { ctx, rpcCalls, ls } = run({ hasPartnerSession: true, userId: 'user-1', rpcImpl: () => Promise.reject(new Error('network down')) });
    let threw = false;
    try { ctx.recordAppActivationIfSignedIn(); } catch (e) { threw = true; }
    await settle();
    ok(!threw, 'partner-app.html: an RPC rejection does not throw synchronously');
    ok(rpcCalls.length === 1, 'partner-app.html: the RPC was attempted despite the eventual rejection');
    ok(ls.getItem('oq_partner_app_activated:user-1') !== '1', 'partner-app.html: a rejected call does not set the localStorage flag');
  }
  {
    // localStorage guard: already recorded -> no RPC call at all.
    const { ctx, rpcCalls } = run({ hasPartnerSession: true, userId: 'user-1', preflaggedFor: 'user-1' });
    ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(rpcCalls.length === 0, 'partner-app.html: the localStorage guard skips a redundant RPC call on a later launch');
  }
  {
    // gh-2154-P2 fix-up: user A's flag is set, then user B signs in on the
    // SAME device (shared localStorage). A device-wide key would make B's
    // launch look "already activated" and skip the RPC entirely -- the
    // fix scopes the flag per user id so B's own activation is still
    // recorded server-side.
    const sharedLs = makeLocalStorage();
    const a = run({ hasPartnerSession: true, userId: 'user-A', ls: sharedLs });
    a.ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(a.rpcCalls.length === 1, 'partner-app.html: user A (first on this device) triggers the RPC');

    const b = run({ hasPartnerSession: true, userId: 'user-B', ls: sharedLs });
    b.ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(b.rpcCalls.length === 1 && b.rpcCalls[0] === 'record_partner_app_activation',
      'partner-app.html: user B signing in on the SAME device as already-activated user A still triggers the RPC for B');
    ok(sharedLs.getItem('oq_partner_app_activated:user-B') === '1', 'partner-app.html: user B gets their own per-user flag, independent of user A\'s');
  }
  {
    // No user id obtainable (Auth.getUser() resolves null) -> skip the
    // localStorage shortcut entirely and just call the RPC (server-side is
    // first-write-wins, so this is always safe).
    const { ctx, rpcCalls, ls } = run({ hasPartnerSession: true, userId: null });
    ctx.recordAppActivationIfSignedIn();
    await settle();
    ok(rpcCalls.length === 1, 'partner-app.html: no user id available -> the RPC is still called (localStorage shortcut skipped)');
    ok(ls._store.size === 0, 'partner-app.html: no user id available -> nothing is written to localStorage');
  }
}

// ── partner-dashboard.html ──────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'partner-dashboard.html'), 'utf8');
  const fnBlock = extractBetween(
    src,
    'function isStandaloneLaunch() {',
    '\n        // Initialize',
    'partner-dashboard.html isStandaloneLaunch()/recordAppActivationIfSignedIn()'
  );
  const gateBlock = extractBetween(
    src,
    'if (currentUser && isStandaloneLaunch()) {',
    '\n            // gh-fix: reveal/hide',
    'partner-dashboard.html init() activation gate'
  );

  function run({ standalone, userAgentStandalone = false, rpcImpl, ls: sharedLs } = {}) {
    const ls = sharedLs || makeLocalStorage();
    const rpcCalls = [];
    const sb = {
      rpc: (name) => {
        rpcCalls.push(name);
        return (rpcImpl || (() => Promise.resolve({ data: true, error: null })))();
      },
    };
    const mediaMatches = !!standalone;
    const ctx = {
      window: {
        matchMedia: () => ({ matches: mediaMatches }),
        navigator: { standalone: userAgentStandalone },
        localStorage: ls,
      },
      sb,
      Promise,
      console,
    };
    ctx.window.window = ctx.window;
    ctx.navigator = ctx.window.navigator;
    vm.createContext(ctx);
    vm.runInContext(fnBlock, ctx);
    return { ctx, rpcCalls, ls };
  }

  async function settle() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

  // Pin the exact init() gating shape this test relies on (never called
  // directly here -- init() has too many unrelated dependencies to run in
  // this harness -- so the gate itself is exercised as extracted text below).
  ok(gateBlock.indexOf('recordAppActivationIfSignedIn(currentUser.id)') !== -1,
    'partner-dashboard.html: init() calls recordAppActivationIfSignedIn(currentUser.id) inside the currentUser && isStandaloneLaunch() gate');

  {
    const { ctx, rpcCalls, ls } = run({ standalone: true });
    // Mirrors init()'s gate: `if (currentUser && isStandaloneLaunch())`.
    const currentUser = { id: 'user-1' };
    if (currentUser && ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(currentUser.id); }
    await settle();
    ok(rpcCalls.length === 1 && rpcCalls[0] === 'record_partner_app_activation', 'partner-dashboard.html: standalone + signed-in calls record_partner_app_activation exactly once');
    ok(ls.getItem('oq_partner_app_activated:user-1') === '1', 'partner-dashboard.html: the per-user localStorage flag is set after a successful call');
  }
  {
    const { ctx, rpcCalls } = run({ standalone: true });
    const currentUser = null; // signed out (Auth.requireAuth() returned null, DEMO_MODE path)
    if (currentUser && ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(currentUser && currentUser.id); }
    await settle();
    ok(rpcCalls.length === 0, 'partner-dashboard.html NEGATIVE CONTROL: standalone + signed-out never calls the RPC');
  }
  {
    const { ctx, rpcCalls } = run({ standalone: false });
    const currentUser = { id: 'user-2' };
    if (currentUser && ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(currentUser.id); }
    await settle();
    ok(rpcCalls.length === 0, 'partner-dashboard.html: non-standalone (regular browser tab) never calls the RPC');
  }
  {
    const { ctx, rpcCalls, ls } = run({ standalone: true, rpcImpl: () => Promise.reject(new Error('network down')) });
    const currentUser = { id: 'user-3' };
    let threw = false;
    try { if (currentUser && ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(currentUser.id); } } catch (e) { threw = true; }
    await settle();
    ok(!threw, 'partner-dashboard.html: an RPC rejection does not throw synchronously');
    ok(rpcCalls.length === 1, 'partner-dashboard.html: the RPC was attempted despite the eventual rejection');
    ok(ls.getItem('oq_partner_app_activated:user-3') !== '1', 'partner-dashboard.html: a rejected call does not set the localStorage flag');
  }
  {
    // iOS standalone signal (navigator.standalone), not matchMedia.
    const { ctx, rpcCalls } = run({ standalone: false, userAgentStandalone: true });
    const currentUser = { id: 'user-4' };
    if (currentUser && ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(currentUser.id); }
    await settle();
    ok(rpcCalls.length === 1, 'partner-dashboard.html: iOS navigator.standalone alone also counts as standalone');
  }
  {
    // gh-2154-P2 fix-up: user A's flag is set, then user B signs in on the
    // SAME device (shared localStorage) -- assert the RPC IS called for B.
    const sharedLs = makeLocalStorage();
    const a = run({ standalone: true, ls: sharedLs });
    const userA = { id: 'user-A' };
    if (userA && a.ctx.isStandaloneLaunch()) { a.ctx.recordAppActivationIfSignedIn(userA.id); }
    await settle();
    ok(a.rpcCalls.length === 1, 'partner-dashboard.html: user A (first on this device) triggers the RPC');

    const b = run({ standalone: true, ls: sharedLs });
    const userB = { id: 'user-B' };
    if (userB && b.ctx.isStandaloneLaunch()) { b.ctx.recordAppActivationIfSignedIn(userB.id); }
    await settle();
    ok(b.rpcCalls.length === 1 && b.rpcCalls[0] === 'record_partner_app_activation',
      'partner-dashboard.html: user B signing in on the SAME device as already-activated user A still triggers the RPC for B');
    ok(sharedLs.getItem('oq_partner_app_activated:user-B') === '1', 'partner-dashboard.html: user B gets their own per-user flag, independent of user A\'s');
  }
  {
    // No user id available -> skip the localStorage shortcut, just call the RPC.
    const { ctx, rpcCalls, ls } = run({ standalone: true });
    if (ctx.isStandaloneLaunch()) { ctx.recordAppActivationIfSignedIn(null); }
    await settle();
    ok(rpcCalls.length === 1, 'partner-dashboard.html: no user id available -> the RPC is still called (localStorage shortcut skipped)');
    ok(ls._store.size === 0, 'partner-dashboard.html: no user id available -> nothing is written to localStorage');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
