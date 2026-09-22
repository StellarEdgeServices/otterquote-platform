/**
 * gh-2096 REVIEW fix (PR #2114, comment 5782483911) — pins the
 * restore-then-abandon sequence: a bfcache `pageshow` restore must reset
 * `abandonSuppressedByNav` back to `false`, or a visitor who completes the
 * funnel once and is later bfcache-restored to the same document (the
 * gh-1994 Android/iOS back-gesture path this file's own `pageshow` handler
 * already names) has every LATER genuine abandonment silently suppressed
 * for the rest of that page's life.
 *
 * start.html has no module export (its whole router lives inside one
 * anonymous IIFE, unlike js/router-discovery.js etc.), so
 * tests/gh2096-dropoff-layer.mjs's own top comment names this gap
 * explicitly. Rather than build the large DOM start.html's full IIFE would
 * need to load top-to-bottom without throwing (every #step1/#step2/#step2a
 * form element, Supabase, CONFIG, Sentry...), this file extracts the THREE
 * specific, self-contained source blocks the bug and its fix live in --
 * verbatim, by anchor text, out of the REAL start.html at test-run time,
 * never a hand-retyped copy -- and runs them in a `vm` context behind
 * minimal stand-ins for the small number of external symbols those three
 * blocks call (trackStepComplete/renderStep/appendParams/collectAttribution
 * -- none of which this bug or fix touches). This is intentionally the
 * narrowest harness that can pin this one behavior; it does not attempt to
 * drive the router's real UI and is not a substitute for a full start.html
 * harness, which stays a named gap.
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

// ── Extract the three real source blocks by anchor text (never a
// hand-retyped copy, and robust to line-number drift elsewhere in the
// file). Any extraction failure throws immediately and loudly -- a
// missing anchor means this file's own shape changed and this test needs
// a fresh look, not a silently-wrong pin. ──
function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor not found (start): ' + label);
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor not found (end): ' + label);
  return src.slice(startIdx, endIdx);
}

// Block A: STEP_INDEX_AB / UA_CONTEXT / the abandon-state vars / trackRouter.
const blockA = extractBetween(
  startSrc,
  'var STEP_INDEX_AB = {',
  '\n\n  // ── Phone validation:',
  'STEP_INDEX_AB..trackRouter'
);
// Block B: redirectTo (sets abandonSuppressedByNav = true).
const blockB = extractBetween(
  startSrc,
  'function redirectTo(dest, preBuilt) {',
  '\n\n  // gh-1994 fix round 2 (Ben, non-blocking item)',
  'redirectTo'
);
// Block C: the pageshow handler (this PR's own fix) through the abandon
// beacon's pagehide/visibilitychange listeners.
const blockC = extractBetween(
  startSrc,
  "window.addEventListener('pageshow', function (e) {",
  "\n\n  // gh-2017: arm C's bridge, assembled LAST",
  'pageshow..visibilitychange'
);

ok(blockA.indexOf('function trackRouter(') !== -1, 'Block A extraction includes trackRouter');
ok(blockB.indexOf('abandonSuppressedByNav = true;') !== -1, 'Block B extraction includes the abandonSuppressedByNav = true line');
ok(blockC.indexOf('abandonSuppressedByNav = false;') !== -1, 'Block C extraction includes this PR\'s own fix line');
ok(blockC.indexOf('function sendAbandonBeacon(') !== -1, 'Block C extraction includes sendAbandonBeacon');

function buildScenario() {
  const gtagCalls = [];
  const windowListeners = {};
  const fakeWindow = {
    location: { href: '' },
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }
  };
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }
  };
  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    history: { replaceState: function () {} },
    sessionStorage: { removeItem: function () {} },
    Date: Date,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Math: Math,
    String: String,
    gtag: function (action, name, params) { gtagCalls.push({ action: action, name: name, params: params }); }
  };
  const ctx = vm.createContext(sandbox);

  // Glue: the handful of free variables/functions Blocks A/B/C reference
  // that this narrow harness does not itself extract -- none of them are
  // part of the bug or its fix. `renderStep` is a no-op here, which means
  // (unlike production, where renderStep() itself calls trackRouter to
  // record the freshly-shown screen) this harness's own driver calls
  // trackRouter('router_step_view', ...) BY HAND after firing pageshow, to
  // stand in for that one side effect -- see each scenario's own comment
  // at that call site.
  const glue = [
    "var variant = 'a';",
    "var oqInternalWalk = false;",
    "var leadId = null;",
    "var _oqTrackQueue = [];",
    "var ENTRY_STEP = 1;",
    "var LEAD_ID_STORAGE_KEY = 'oq_router_lead_id';",
    "function trackStepComplete() {}",
    "function renderStep(step) {}",
    "function appendParams(base, obj) { return base; }",
    "function collectAttribution() { return {}; }"
  ].join('\n');

  const wrapped = '(function () {\n' + glue + '\n' + blockA + '\n' + blockB + '\n' + blockC + '\n' +
    'window.__test = { trackRouter: trackRouter, redirectTo: redirectTo };\n' +
    '})();';
  vm.runInContext(wrapped, ctx, { filename: 'start.html (extracted: gh-2096 abandon beacon + pageshow restore)' });

  return {
    trackRouter: sandbox.window.__test.trackRouter,
    redirectTo: sandbox.window.__test.redirectTo,
    gtagCalls: gtagCalls,
    firePageshow: (persisted) => (windowListeners.pageshow || []).forEach((fn) => fn({ persisted: persisted })),
    firePagehide: () => (windowListeners.pagehide || []).forEach((fn) => fn())
  };
}

// ═══ Scenario 1 (the bug, fixed): complete the funnel (redirectTo sets
// abandonSuppressedByNav = true) -> bfcache-restore via pageshow(persisted:
// true) -> a genuine LATER abandonment (pagehide) must fire
// router_step_abandoned, not be silently suppressed by the stale flag. ═══
(function scenario1() {
  const { trackRouter, redirectTo, gtagCalls, firePageshow, firePagehide } = buildScenario();
  trackRouter('router_step_view', { step: 1 }); // first screen shown
  redirectTo('https://app.otterquote.com/get-started', true); // visitor completes the funnel
  ok(gtagCalls.filter((c) => c.name === 'router_step_abandoned').length === 0, 'no abandon event yet -- redirectTo is a completion, not a drop');
  firePageshow(true); // bfcache restore (Back-gesture from the destination page)
  // Stand-in for renderStep(ENTRY_STEP)'s own real-world side effect (see
  // buildScenario's own comment) -- the visitor is looking at a fresh
  // screen again after the restore.
  trackRouter('router_step_view', { step: 1 });
  firePagehide(); // this time, a REAL exit -- tab/app closed, never returns
  const abandoned = gtagCalls.filter((c) => c.name === 'router_step_abandoned');
  ok(abandoned.length === 1, 'router_step_abandoned fires exactly once after the bfcache-restore + later genuine exit (the bug this PR fixes: this used to be 0)');
  ok(abandoned.length === 1 && abandoned[0].params.step === 1, 'the abandoned event carries the post-restore step');
})();

// ═══ Scenario 2 (negative control): complete the funnel and abandon
// WITHOUT any bfcache restore in between -- must NOT fire, same as before
// this PR. Guards against an over-correction that deletes the suppression
// check entirely instead of just resetting it on restore. ═══
(function scenario2() {
  const { trackRouter, redirectTo, gtagCalls, firePagehide } = buildScenario();
  trackRouter('router_step_view', { step: 1 });
  redirectTo('https://app.otterquote.com/get-started', true);
  firePagehide(); // same page instance, no restore -- this IS the completion's own unload
  ok(gtagCalls.filter((c) => c.name === 'router_step_abandoned').length === 0,
    'no router_step_abandoned fires for the completing pagehide itself, with no restore in between -- suppression still works for the ordinary case');
})();

console.log('\n=== Summary ===');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
