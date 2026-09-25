/**
 * gh-2154 P-2 -- first signed-in standalone launch of the installed partner
 * app calls the new `record_partner_app_activation` RPC exactly once (per
 * user, per device), fails silently, never fires when signed out, not
 * running standalone, or the partner row isn't resolved/linked yet, and
 * never permanently loses the activation when the RPC returns `data:false`.
 *
 * REVIEW FAIL 5818340009 (2026-09-24): head `1a134b76` set the localStorage
 * flag whenever `!res.error`, including when `record_partner_app_activation`
 * returned `{data:false, error:null}` -- which happens both when the
 * timestamp was already set AND when the caller's referral_agents row isn't
 * linked yet (user_id IS NULL). Since the call fired right after
 * requireAuth(), before claim_partner_account() ran, an unlinked first
 * launch could set the flag and permanently skip the RPC on that device even
 * after the row got linked. Fix: only set the flag on `res.data === true`,
 * and only fire the call once currentPartner is resolved (post-claim),
 * skipping it entirely if currentPartner.app_first_signed_in_launch_at is
 * already set. This file's "record_partner_app_activation: {data:false}"
 * case (below) is written to FAIL against head `1a134b76` and PASS after the
 * fix -- see the report for both raw runs.
 *
 * partner-app.html's pre-redirect call was removed entirely in this round
 * (the dashboard is the reliable path, as the PR itself said), so this file
 * now only exercises partner-dashboard.html.
 *
 * Extracts the REAL source (never a hand-retyped copy) out of
 * partner-dashboard.html by anchor text, at test-run time, and runs it in a
 * `vm` context behind minimal sb/localStorage stand-ins -- same technique as
 * tests/gh2096-abandon-beacon-restore.mjs and tests/gh2122-arm-f.mjs.
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

async function settle() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

// ── partner-dashboard.html ──────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'partner-dashboard.html'), 'utf8');
  const fnBlock = extractBetween(
    src,
    'function isStandaloneLaunch() {',
    '\n        // Initialize',
    'partner-dashboard.html isStandaloneLaunch()/recordAppActivationIfSignedIn()'
  );
  // Pin the exact init() gating shape this test relies on (never called
  // directly here -- init() has too many unrelated dependencies to run in
  // this harness -- so the gate itself is exercised as extracted text below,
  // and each scenario below reproduces its condition inline (fireGate())
  // against the real extracted isStandaloneLaunch()/
  // recordAppActivationIfSignedIn()). Wrapped in try/catch (rather than
  // letting extractBetween throw) so that running this file against a
  // pre-fix head (e.g. 1a134b76, where the gate lived elsewhere, before
  // currentPartner was resolved) still reports these two as FAILs and lets
  // every other scenario below run -- in particular the {data:false} case,
  // which is the one this round's must-fix is about.
  try {
    const gateBlock = extractBetween(
      src,
      'if (currentPartner && isStandaloneLaunch()',
      '\n\n                    updateUI();',
      'partner-dashboard.html init() post-claim activation gate'
    );
    ok(gateBlock.indexOf('currentPartner && isStandaloneLaunch() && !currentPartner.app_first_signed_in_launch_at') !== -1,
      'partner-dashboard.html: init() gates on currentPartner (post-claim) + isStandaloneLaunch() + app_first_signed_in_launch_at IS NULL');
    ok(gateBlock.indexOf('recordAppActivationIfSignedIn(currentUser.id)') !== -1,
      'partner-dashboard.html: init() calls recordAppActivationIfSignedIn(currentUser.id) inside that gate');
  } catch (e) {
    ok(false, 'partner-dashboard.html: init() gates on currentPartner (post-claim) + isStandaloneLaunch() + app_first_signed_in_launch_at IS NULL (' + e.message + ')');
    ok(false, 'partner-dashboard.html: init() calls recordAppActivationIfSignedIn(currentUser.id) inside that gate (' + e.message + ')');
  }

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

  // Reproduces the real post-claim gate:
  //   if (currentPartner && isStandaloneLaunch() && !currentPartner.app_first_signed_in_launch_at) {
  //       recordAppActivationIfSignedIn(currentUser.id);
  //   }
  function fireGate(ctx, currentUser, currentPartner) {
    if (currentPartner && ctx.isStandaloneLaunch() && !currentPartner.app_first_signed_in_launch_at) {
      ctx.recordAppActivationIfSignedIn(currentUser.id);
    }
  }

  {
    const { ctx, rpcCalls, ls } = run({ standalone: true });
    const currentUser = { id: 'user-1' };
    const currentPartner = { id: 'p-1', app_first_signed_in_launch_at: null };
    fireGate(ctx, currentUser, currentPartner);
    await settle();
    ok(rpcCalls.length === 1 && rpcCalls[0] === 'record_partner_app_activation', 'partner-dashboard.html: standalone + signed-in + linked partner calls record_partner_app_activation exactly once');
    ok(ls.getItem('oq_partner_app_activated:user-1') === '1', 'partner-dashboard.html: the per-user localStorage flag is set after a res.data===true call');
  }
  {
    const { ctx, rpcCalls } = run({ standalone: true });
    const currentUser = null; // signed out (Auth.requireAuth() returned null, DEMO_MODE path)
    fireGate(ctx, currentUser, null);
    await settle();
    ok(rpcCalls.length === 0, 'partner-dashboard.html NEGATIVE CONTROL: standalone + signed-out never calls the RPC');
  }
  {
    const { ctx, rpcCalls } = run({ standalone: false });
    const currentUser = { id: 'user-2' };
    const currentPartner = { id: 'p-2', app_first_signed_in_launch_at: null };
    fireGate(ctx, currentUser, currentPartner);
    await settle();
    ok(rpcCalls.length === 0, 'partner-dashboard.html: non-standalone (regular browser tab) never calls the RPC');
  }
  {
    const { ctx, rpcCalls, ls } = run({ standalone: true, rpcImpl: () => Promise.reject(new Error('network down')) });
    const currentUser = { id: 'user-3' };
    const currentPartner = { id: 'p-3', app_first_signed_in_launch_at: null };
    let threw = false;
    try { fireGate(ctx, currentUser, currentPartner); } catch (e) { threw = true; }
    await settle();
    ok(!threw, 'partner-dashboard.html: an RPC rejection does not throw synchronously');
    ok(rpcCalls.length === 1, 'partner-dashboard.html: the RPC was attempted despite the eventual rejection');
    ok(ls.getItem('oq_partner_app_activated:user-3') !== '1', 'partner-dashboard.html: a rejected call does not set the localStorage flag');
  }
  {
    // iOS standalone signal (navigator.standalone), not matchMedia.
    const { ctx, rpcCalls } = run({ standalone: false, userAgentStandalone: true });
    const currentUser = { id: 'user-4' };
    const currentPartner = { id: 'p-4', app_first_signed_in_launch_at: null };
    fireGate(ctx, currentUser, currentPartner);
    await settle();
    ok(rpcCalls.length === 1, 'partner-dashboard.html: iOS navigator.standalone alone also counts as standalone');
  }
  {
    // gh-2154-P2 fix-up round: user A's flag is set, then user B signs in on
    // the SAME device (shared localStorage) -- assert the RPC IS called for B.
    const sharedLs = makeLocalStorage();
    const a = run({ standalone: true, ls: sharedLs });
    const userA = { id: 'user-A' };
    const partnerA = { id: 'p-A', app_first_signed_in_launch_at: null };
    fireGate(a.ctx, userA, partnerA);
    await settle();
    ok(a.rpcCalls.length === 1, 'partner-dashboard.html: user A (first on this device) triggers the RPC');

    const b = run({ standalone: true, ls: sharedLs });
    const userB = { id: 'user-B' };
    const partnerB = { id: 'p-B', app_first_signed_in_launch_at: null };
    fireGate(b.ctx, userB, partnerB);
    await settle();
    ok(b.rpcCalls.length === 1 && b.rpcCalls[0] === 'record_partner_app_activation',
      'partner-dashboard.html: user B signing in on the SAME device as already-activated user A still triggers the RPC for B');
    ok(sharedLs.getItem('oq_partner_app_activated:user-B') === '1', 'partner-dashboard.html: user B gets their own per-user flag, independent of user A\'s');
  }
  {
    // No user id available -> skip the localStorage shortcut, just call the RPC.
    const { ctx, rpcCalls, ls } = run({ standalone: true });
    const currentPartner = { id: 'p-5', app_first_signed_in_launch_at: null };
    fireGate(ctx, { id: null }, currentPartner);
    await settle();
    ok(rpcCalls.length === 1, 'partner-dashboard.html: no user id available -> the RPC is still called (localStorage shortcut skipped)');
    ok(ls._store.size === 0, 'partner-dashboard.html: no user id available -> nothing is written to localStorage');
  }

  // ── REVIEW FAIL 5818340009 must-fix (i): {data:false} must not lose the
  // activation -- the flag stays unset and the next launch retries the RPC.
  {
    const ls = makeLocalStorage();
    const currentUser = { id: 'user-6' };

    // Launch 1: RPC returns {data:false, error:null} -- e.g. the row wasn't
    // linked yet at call time, or the timestamp was already set by another
    // device. Either way, this call did NOT write the row.
    const launch1 = run({ standalone: true, ls, rpcImpl: () => Promise.resolve({ data: false, error: null }) });
    const partnerAtLaunch1 = { id: 'p-6', app_first_signed_in_launch_at: null };
    fireGate(launch1.ctx, currentUser, partnerAtLaunch1);
    await settle();
    ok(launch1.rpcCalls.length === 1, 'partner-dashboard.html: {data:false} still attempts the RPC');
    ok(ls.getItem('oq_partner_app_activated:user-6') !== '1', 'partner-dashboard.html: {data:false} leaves the localStorage flag UNSET (does not lose the activation)');

    // Launch 2 (same device, same user): server-side column is still NULL
    // (the {data:false} call above never wrote it), so the RPC must be
    // retried -- not silently skipped because of a wrongly-set flag.
    const launch2 = run({ standalone: true, ls, rpcImpl: () => Promise.resolve({ data: true, error: null }) });
    const partnerAtLaunch2 = { id: 'p-6', app_first_signed_in_launch_at: null };
    fireGate(launch2.ctx, currentUser, partnerAtLaunch2);
    await settle();
    ok(launch2.rpcCalls.length === 1, 'partner-dashboard.html: the next launch after a {data:false} response retries the RPC (flag did not block it)');
    ok(ls.getItem('oq_partner_app_activated:user-6') === '1', 'partner-dashboard.html: the retried call, now data:true, finally sets the flag');
  }

  // ── REVIEW FAIL 5818340009 must-fix (d)(ii): an unlinked partner at init
  // (claim pending) must not lose the activation -- once linked, the call
  // happens and records.
  {
    const ls = makeLocalStorage();
    const currentUser = { id: 'user-7' };

    // Launch 1: currentPartner is still null (claim_partner_account() is
    // pending / failed this round) -- the gate itself must not fire at all,
    // since there is no linked row to write to yet.
    const launch1 = run({ standalone: true, ls });
    fireGate(launch1.ctx, currentUser, null);
    await settle();
    ok(launch1.rpcCalls.length === 0, 'partner-dashboard.html: an unlinked partner (currentPartner still null) makes no RPC call at all');
    ok(ls._store.size === 0, 'partner-dashboard.html: an unlinked partner writes no localStorage flag');

    // Launch 2: the row is now linked (currentPartner resolved, post-claim).
    // The activation must still be recorded -- it must not have been lost
    // by launch 1's no-op.
    const launch2 = run({ standalone: true, ls });
    const linkedPartner = { id: 'p-7', app_first_signed_in_launch_at: null };
    fireGate(launch2.ctx, currentUser, linkedPartner);
    await settle();
    ok(launch2.rpcCalls.length === 1, 'partner-dashboard.html: once linked, the call happens and records the activation');
    ok(ls.getItem('oq_partner_app_activated:user-7') === '1', 'partner-dashboard.html: the flag is set once the linked launch succeeds');
  }

  // ── REVIEW FAIL 5818340009 must-fix (d)(iii): currentPartner.
  // app_first_signed_in_launch_at already set -> skip the call entirely
  // (no RPC round-trip needed).
  {
    const { ctx, rpcCalls } = run({ standalone: true });
    const currentUser = { id: 'user-8' };
    const alreadyActivatedPartner = { id: 'p-8', app_first_signed_in_launch_at: '2026-09-01T00:00:00Z' };
    fireGate(ctx, currentUser, alreadyActivatedPartner);
    await settle();
    ok(rpcCalls.length === 0, 'partner-dashboard.html: currentPartner.app_first_signed_in_launch_at already set -> no RPC call at all');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
