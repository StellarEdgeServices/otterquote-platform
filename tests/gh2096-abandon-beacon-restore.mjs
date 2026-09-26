/**
 * gh-2096 REVIEW fix, round 2 (PR #2114, comment 5796844493) -- pins the
 * restore-then-abandon sequence on the arms that actually carry live
 * traffic, not just arm A.
 *
 * Round 1 of this file (comment 5782483911's fix) proved that a bfcache
 * `pageshow` restore resets `abandonSuppressedByNav` back to `false`. But
 * round 1's own harness hard-coded `variant = 'a'` and, after firing
 * `pageshow`, HAND-CALLED `trackRouter('router_step_view', {step:1})` to
 * stand in for `renderStep(ENTRY_STEP)`'s real production side effect. On
 * arm A that stand-in is faithful: `renderStep` is not guarded there. On
 * every LIVE arm (C, D, E) it is not: `renderStep`'s own first line is
 * `if (ARM_C || ARM_D || ARM_E) return;` (start.html, ~line 709), so
 * `renderStep(ENTRY_STEP)` never reaches its `trackRouter` call on any of
 * them. Hand-calling that stand-in regardless of arm papered over exactly
 * the gap the round-2 review found: `abandonCurrentStep` is left pointing
 * at the step the visitor already completed, so a later genuine exit fires
 * `router_step_abandoned` for a step that was NOT abandoned -- a false
 * abandon on live traffic, at the exact step this issue exists to measure.
 *
 * This file no longer hand-calls that stand-in at all. Instead it extracts
 * the REAL `renderStep` function (verbatim, by anchor text, same as the
 * other blocks below) and the REAL `ARM_B`/`ARM_C`/`ARM_D`/`ARM_E`/
 * `stepToken`/`ENTRY_STEP` definitions, so the extracted `pageshow` handler
 * calls the actual guarded `renderStep` -- which correctly no-ops for
 * C/D/E and correctly re-fires a view for A -- exactly as production does.
 * Every restore-path scenario below runs once per arm in
 * `['a', 'c', 'd', 'e']` (or `['c', 'd', 'e']` where arm A does not apply),
 * driven only by firing the same DOM events production fires; nothing
 * calls trackRouter/renderStep directly to fake a reset.
 *
 * start.html has no module export (its whole router lives inside one
 * anonymous IIFE, unlike js/router-discovery.js etc.), so
 * tests/gh2096-dropoff-layer.mjs's own top comment names this gap
 * explicitly. Rather than build the large DOM start.html's full IIFE would
 * need to load top-to-bottom without throwing (every #step1/#step2/#step2a
 * form element, Supabase, CONFIG, Sentry...), this file extracts the
 * specific, self-contained source blocks the bug and its fix live in --
 * verbatim, by anchor text, out of the REAL start.html at test-run time,
 * never a hand-retyped copy -- and runs them in a `vm` context behind
 * minimal DOM/timer stand-ins for the small number of external symbols
 * those blocks call. This is intentionally the narrowest harness that can
 * pin this behavior; it does not attempt to drive the router's real UI and
 * is not a substitute for a full start.html harness, which stays a named
 * gap.
 *
 * Run: node tests/gh2096-abandon-beacon-restore.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const startSrc = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// ── Extract the real source blocks by anchor text (never a hand-retyped
// copy, and robust to line-number drift elsewhere in the file). Any
// extraction failure throws immediately and loudly -- a missing anchor
// means this file's own shape changed and this test needs a fresh look,
// not a silently-wrong pin. ──
function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor not found (start): ' + label);
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor not found (end): ' + label);
  return src.slice(startIdx, endIdx);
}

// Block ARMS: ARM_B/ARM_C/ARM_D/ARM_E, B_STEP_TOKENS, stepToken, ENTRY_STEP.
// This is the piece round 1 of this file never extracted -- it hard-coded
// ENTRY_STEP and skipped ARM_* entirely, which is exactly why its own
// renderStep stand-in couldn't reproduce the live-arm early return.
const blockArms = extractBetween(
  startSrc,
  "var ARM_B = variant === 'b';",
  "\n\n  // gh-2016: arm B's contact screen is the last screen",
  'ARM_B..ENTRY_STEP'
);
// Block RENDER_STEP: the real renderStep, including its
// `if (ARM_C || ARM_D || ARM_E) return;` guard -- the guard round 1's
// hand-called stand-in bypassed.
const blockRenderStep = extractBetween(
  startSrc,
  'function renderStep(key) {',
  '\n\n  function showError(msg) {',
  'renderStep'
);
// Block TRACK: STEP_INDEX_AB / UA_CONTEXT / the abandon-state vars / trackRouter.
const blockTrack = extractBetween(
  startSrc,
  'var STEP_INDEX_AB = {',
  '\n\n  // ── Phone validation:',
  'STEP_INDEX_AB..trackRouter'
);
// Block REDIRECT: redirectTo (sets abandonSuppressedByNav = true).
const blockRedirect = extractBetween(
  startSrc,
  'function redirectTo(dest, preBuilt) {',
  '\n\n  // gh-1994 fix round 2 (Ben, non-blocking item)',
  'redirectTo'
);
// Block RESTORE: the pageshow handler (this PR's own round-2 fix) through
// the abandon beacon's pagehide/visibilitychange listeners.
const blockRestore = extractBetween(
  startSrc,
  "window.addEventListener('pageshow', function (e) {",
  "\n\n  // gh-2017: arm C's bridge, assembled LAST",
  'pageshow..visibilitychange'
);

ok(blockArms.indexOf("var ARM_C = variant === 'c';") !== -1, 'ARM extraction includes ARM_C');
ok(blockArms.indexOf("var ARM_D = variant === 'd';") !== -1, 'ARM extraction includes ARM_D');
ok(blockArms.indexOf("var ARM_E = variant === 'e';") !== -1, 'ARM extraction includes ARM_E');
ok(blockArms.indexOf('var ENTRY_STEP = ARM_B ? 2 : 1;') !== -1, 'ARM extraction includes ENTRY_STEP');
// gh-2122: Arm F joined the guard (`ARM_C || ARM_D || ARM_E || ARM_F`).
ok(blockRenderStep.indexOf('if (ARM_C || ARM_D || ARM_E || ARM_F) return;') !== -1, 'renderStep extraction includes the live-arm early-return guard -- the exact line round 1\'s hand-called stand-in bypassed');
ok(blockTrack.indexOf('function trackRouter(') !== -1, 'Block TRACK extraction includes trackRouter');
ok(blockRedirect.indexOf('abandonSuppressedByNav = true;') !== -1, 'Block REDIRECT extraction includes the abandonSuppressedByNav = true line');
ok(blockRestore.indexOf('abandonSuppressedByNav = false;') !== -1, 'Block RESTORE extraction includes the suppression-flag reset');
ok(blockRestore.indexOf('abandonCurrentStep = null;') !== -1, 'Block RESTORE extraction includes this PR\'s round-2 fix (clearing abandonCurrentStep directly, not via renderStep)');
ok(blockRestore.indexOf('function sendAbandonBeacon(') !== -1, 'Block RESTORE extraction includes sendAbandonBeacon');

function buildScenario(variant) {
  const gtagCalls = [];
  const windowListeners = {};
  const timers = { scheduled: {}, nextId: 1 };
  const fakeWindow = {
    location: { href: '' },
    scrollTo: function () {},
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }
  };
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }
  };
  function fakeClassed() { return { classList: { toggle: function () {}, add: function () {}, remove: function () {} } }; }
  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    history: { replaceState: function () {} },
    sessionStorage: { removeItem: function () {} },
    // renderStep's DOM: only classList.toggle is ever called on these
    // (ARM_B is false for every scenario below, so the querySelector('h1')
    // branch is never reached and does not need a stand-in).
    steps: { 1: fakeClassed(), 2: fakeClassed(), '2a': fakeClassed(), 3: fakeClassed() },
    progressEls: { 1: fakeClassed(), 2: fakeClassed(), 3: fakeClassed() },
    routerError: { classList: { remove: function () {} }, textContent: '' },
    Date: Date,
    Math: Math,
    String: String,
    Object: Object,
    // Instrumented, non-firing setTimeout/clearTimeout: scenario 3 below
    // needs to observe exactly what the restore handler schedules/clears
    // without waiting out ABANDON_HIDDEN_GRACE_MS for real.
    setTimeout: function (fn) { const id = timers.nextId++; timers.scheduled[id] = fn; return id; },
    clearTimeout: function (id) { delete timers.scheduled[id]; },
    gtag: function (action, name, params) { gtagCalls.push({ action: action, name: name, params: params }); }
  };
  const ctx = vm.createContext(sandbox);

  // Glue: the handful of free variables/functions the extracted blocks
  // reference that this narrow harness does not itself extract -- none of
  // them are part of the bug or its fix.
  const glue = [
    "var variant = '" + variant + "';",
    "var oqInternalWalk = false;",
    "var leadId = null;",
    "var _oqTrackQueue = [];",
    "var LEAD_ID_STORAGE_KEY = 'oq_router_lead_id';",
    "function trackStepComplete() {}",
    "function appendParams(base, obj) { return base; }",
    "function collectAttribution() { return {}; }"
  ].join('\n');

  const wrapped = '(function () {\n' + glue + '\n' + blockArms + '\n' + blockRenderStep + '\n' +
    blockTrack + '\n' + blockRedirect + '\n' + blockRestore + '\n' +
    'window.__test = { trackRouter: trackRouter, redirectTo: redirectTo, renderStep: renderStep };\n' +
    '})();';
  vm.runInContext(wrapped, ctx, { filename: 'start.html (extracted: gh-2096 abandon beacon + pageshow restore, arm=' + variant + ')' });

  return {
    trackRouter: sandbox.window.__test.trackRouter,
    redirectTo: sandbox.window.__test.redirectTo,
    gtagCalls: gtagCalls,
    timers: timers,
    firePageshow: (persisted) => (windowListeners.pageshow || []).forEach((fn) => fn({ persisted: persisted })),
    firePagehide: () => (windowListeners.pagehide || []).forEach((fn) => fn()),
    fireVisibilityHidden: () => { fakeDocument.visibilityState = 'hidden'; (windowListeners.visibilitychange || []).forEach((fn) => fn()); }
  };
}

// A representative pre-redirect step token per arm -- for C/D/E this is the
// step token the visitor is deemed to have just completed (a contact
// screen), matching the review's own repro on arm C ('c-contact').
const STEP_BY_ARM = { a: 2, c: 'c-contact', d: 'd-email', e: 'e-p7-5' };
const LIVE_ARMS = ['c', 'd', 'e'];
const ALL_ARMS = ['a', 'c', 'd', 'e'];

// ═══ Scenario 1: complete the funnel (redirectTo sets
// abandonSuppressedByNav = true) -> bfcache-restore via
// pageshow(persisted: true) -- driven purely by firing the event, with NO
// hand-called stand-in for renderStep's own side effect -- then a genuine
// LATER exit (pagehide). ═══
ALL_ARMS.forEach(function (variant) {
  (function scenario1() {
    const step = STEP_BY_ARM[variant];
    const { trackRouter, redirectTo, gtagCalls, firePageshow, firePagehide } = buildScenario(variant);
    trackRouter('router_step_view', { step: step });
    redirectTo('https://app.otterquote.com/get-started', true); // visitor completes the funnel
    ok(gtagCalls.filter((c) => c.name === 'router_step_abandoned').length === 0,
      '[' + variant + '] no abandon event yet -- redirectTo is a completion, not a drop');
    firePageshow(true); // bfcache restore (Back-gesture from the destination page)
    firePagehide(); // a later, genuine exit -- tab/app closed, never returns
    const abandoned = gtagCalls.filter((c) => c.name === 'router_step_abandoned');
    if (variant === 'a') {
      // Non-live arm: renderStep(ENTRY_STEP) is NOT guarded away, so the
      // restore itself re-emits a real router_step_view for the entry
      // step, and the later genuine exit correctly abandons THAT fresh
      // step -- this is round 1's own scenario, preserved unchanged.
      ok(abandoned.length === 1, '[a] router_step_abandoned fires exactly once for the fresh post-restore view');
      ok(abandoned.length === 1 && abandoned[0].params.step === 1, '[a] the abandoned event carries the post-restore ENTRY_STEP (1), not the stale pre-redirect step (' + step + ')');
    } else {
      // Live arms: renderStep(ENTRY_STEP) early-returns at start.html:709
      // and never re-emits a view. This is REVIEW: FAIL comment
      // 5796844493's exact repro: without this PR's round-2 fix,
      // abandonCurrentStep still holds the completed step, and the later
      // pagehide fires a FALSE router_step_abandoned for it. With the
      // fix, nothing fires -- the tracked step was nulled directly by the
      // restore handler, not left for renderStep to clear.
      ok(abandoned.length === 0,
        '[' + variant + '] no FALSE router_step_abandoned for the already-completed step "' + step + '" after a bfcache restore (renderStep never reaches trackRouter on this arm -- the reset must happen directly in the pageshow handler)');
    }
  })();
});

// ═══ Scenario 2 (negative control): complete the funnel and abandon
// WITHOUT any bfcache restore in between -- must NOT fire, on every arm,
// same as before this PR. Guards against an over-correction that deletes
// the suppression check entirely instead of just resetting it on
// restore. ═══
ALL_ARMS.forEach(function (variant) {
  (function scenario2() {
    const step = STEP_BY_ARM[variant];
    const { trackRouter, redirectTo, gtagCalls, firePagehide } = buildScenario(variant);
    trackRouter('router_step_view', { step: step });
    redirectTo('https://app.otterquote.com/get-started', true);
    firePagehide(); // same page instance, no restore -- this IS the completion's own unload
    ok(gtagCalls.filter((c) => c.name === 'router_step_abandoned').length === 0,
      '[' + variant + '] no router_step_abandoned fires for the completing pagehide itself, with no restore in between');
  })();
});

// ═══ Scenario 3 (live arms only): a visibilitychange grace timer armed
// BEFORE the restore (the pre-restore page was briefly backgrounded, still
// inside its ABANDON_HIDDEN_GRACE_MS window when the restore happens) must
// not be left to fire later against the now-stale/cleared state. ═══
LIVE_ARMS.forEach(function (variant) {
  (function scenario3() {
    const step = STEP_BY_ARM[variant];
    const { trackRouter, redirectTo, gtagCalls, firePageshow, fireVisibilityHidden, timers } = buildScenario(variant);
    trackRouter('router_step_view', { step: step });
    redirectTo('https://app.otterquote.com/get-started', true); // completes; abandonSuppressedByNav = true
    fireVisibilityHidden(); // stray hidden event on the destination-bound tab arms the grace timer
    const scheduledIds = Object.keys(timers.scheduled);
    ok(scheduledIds.length === 1, '[' + variant + '] the hidden-page grace timer was scheduled before the restore');
    const staleTimerFn = timers.scheduled[scheduledIds[0]];
    firePageshow(true); // bfcache restore
    ok(Object.keys(timers.scheduled).length === 0,
      '[' + variant + '] the pending hidden-page grace timer is cleared directly by the restore handler, not left pending');
    staleTimerFn(); // defense in depth: even if it fired anyway, the reset state must block it
    ok(gtagCalls.filter((c) => c.name === 'router_step_abandoned').length === 0,
      '[' + variant + '] the stale pre-restore timer cannot fire a false abandon even if invoked directly after the restore');
  })();
});

console.log('\n=== Summary ===');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
