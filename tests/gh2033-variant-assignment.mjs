/**
 * gh-2033 — /start assigns the front-door variant itself.
 *
 * gh-2074 (PR #2079) changed what "correctly assigned" means: variants a and
 * b are no longer LIVE. Every arm source (explicit ?v=, persisted
 * localStorage/cookie, and the uniform-random draw) is re-mapped onto
 * LIVE_VARIANTS (today just ['c']) by the head-inline script, and a SECOND,
 * independent read further down start.html (the "propagation channel") must
 * agree with that re-mapped value -- PR #2079's round-2 review found and
 * fixed a real split-brain where that second read could still observe a
 * stale, pre-mapped a/b from the URL when history.replaceState throws (see
 * Check 7 below, which is the committed regression test for that bug).
 * This file's checks and prose now assert the LIVE-set behavior throughout,
 * not a fixed a/b/c three-way split -- LIVE_VARIANTS is read out of
 * start.html itself (not hardcoded here) so this file keeps working
 * unchanged once gh-2075/gh-2076 flip it to ['c','d','e'].
 *
 * No real browser engine (playwright/puppeteer) or jsdom is present in this
 * repo's node_modules or package.json, and no such dependency was added for
 * this harness (checked first, per the work order). Following the existing
 * pattern in tests/cookie-max-age-400-days.mjs, this loads the ACTUAL
 * inline scripts — extracted verbatim from start.html, not reimplemented —
 * into a Node `vm` context behind a minimal DOM shim (window.location,
 * document.cookie, window.localStorage, history). Two separate scripts are
 * extracted and run in the SAME sandbox/window, matching how they run on a
 * real page (two <script> tags, one global window): the head-inline
 * arrival-assignment script (gh-2033/gh-2074), and the second, independent
 * variant read (gh-2014/gh-2033/gh-2074 fix round 2) further down the file.
 *
 * LABEL: this is a Node `vm` + DOM-shim result, NOT a real-browser result.
 * It proves the extracted scripts' own logic under each scenario; it does
 * not prove real Chrome/WebKit/Facebook-in-app-webview behavior. Checks
 * 4's "leads-row" half and check 5 (GA4 attribution) are out of this
 * harness's reach entirely and are reported separately as NOT YET MEASURED
 * / handled by the orchestrator.
 *
 * This suite is REQUIRED to fail cleanly (explicit FAIL + non-zero exit,
 * never an uncaught crash) when pointed at a start.html that predates
 * gh-2074 -- e.g. origin/main before PR #2079 merges -- because the
 * LIVE_VARIANTS / KNOWN_ARMS / window.__oqToLiveArm constructs this file
 * extracts and asserts against do not exist there yet. See the PR #2079
 * body for a pasted run demonstrating that.
 *
 * Run: node tests/gh2033-variant-assignment.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URLSearchParams } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startHtmlPath = path.join(__dirname, '..', 'start.html');
const html = fs.readFileSync(startHtmlPath, 'utf8');

// Extract the gh-2033/gh-2074 inline assignment script verbatim: the first
// <script>...</script> block immediately following the gh-2033 head
// comment, up to (not including) the ga-gate.js loader tag.
const marker = '<!-- gh-2033: /start assigns the A/B/C variant itself';
const markerIdx = html.indexOf(marker);
if (markerIdx === -1) {
  console.log('FAIL: gh-2033 head comment marker not found in start.html — extraction cannot proceed.');
  process.exit(1);
}
const scriptOpenIdx = html.indexOf('<script>', markerIdx);
const scriptCloseIdx = html.indexOf('</script>', scriptOpenIdx);
if (scriptOpenIdx === -1 || scriptCloseIdx === -1) {
  console.log('FAIL: could not locate the gh-2033 <script>...</script> block after the marker.');
  process.exit(1);
}
const assignmentSrc = html.slice(scriptOpenIdx + '<script>'.length, scriptCloseIdx);

// gh-2074 fix round 2 (PR #2079 review): LIVE_VARIANTS is read out of
// start.html itself, never hardcoded here, so this file's assertions track
// the file's own live set automatically (today ['c']; ['c','d','e'] once
// gh-2075/gh-2076 ship — no edit needed here for that flip).
const liveVariantsMatch = html.match(/var LIVE_VARIANTS = (\[[^\]]*\]);/);
if (!liveVariantsMatch) {
  console.log('FAIL: LIVE_VARIANTS constant not found in start.html — this start.html predates gh-2074 '
    + '(PR #2079); this suite\'s live-set assertions cannot be evaluated against it.');
  process.exit(1);
}
let LIVE_VARIANTS;
try {
  LIVE_VARIANTS = new Function('return ' + liveVariantsMatch[1])();
} catch (e) {
  console.log('FAIL: LIVE_VARIANTS constant found but could not be parsed: ' + e.message);
  process.exit(1);
}

// gh-2074 fix round 2: extract the SECOND, independent variant read
// verbatim (the "propagation channel" — a separate <script> block/closure
// further down start.html, gh-2014/gh-2033/gh-2074) so Check 7 below can
// run the REAL logic that PR #2079's split-brain bug lived in, not a
// reimplementation of it.
const secondReadMatch = html.match(
  /var KNOWN_ARMS = window\.__oqKnownArms[\s\S]*?var variant = oqVariantArm \|\| urlFallbackArm;/
);
if (!secondReadMatch) {
  console.log('FAIL: the second-read snippet (var KNOWN_ARMS = window.__oqKnownArms ... var variant = '
    + 'oqVariantArm || urlFallbackArm;) was not found in start.html — this start.html predates the PR #2079 '
    + 'round-2 fix; Check 7 (the split-brain regression test) cannot be evaluated against it.');
  process.exit(1);
}
const secondReadSrc = secondReadMatch[0];

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

/**
 * Build a fresh sandbox and run the extracted head-inline assignment script
 * in it (gh-2033/gh-2074 — sets window.__oqVariant, window.__oqKnownArms,
 * window.__oqToLiveArm, window.__oqLiveVariants, and attempts the
 * URL/localStorage/cookie/replaceState side effects).
 * @param {object} opts
 *   search: URL query string incl leading '?', e.g. '?v=c'
 *   protocol: 'https:' | 'http:'
 *   store: pre-seeded { localStorage: Map, cookies: {} } for persistence tests
 *   throwStorage: if true, localStorage.getItem/setItem throw (webview case)
 *   throwReplaceState: if true, history.replaceState throws SecurityError
 *     (sandboxed iframe without allow-same-origin, Safari history rate
 *     limit — gh-2074 fix round 2's split-brain trigger)
 *   captureConsoleErrors: array to push any console.error/uncaught text into
 */
function runAssignment(opts) {
  opts = opts || {};
  const lsMap = (opts.store && opts.store.localStorage) || new Map();
  const cookieState = { jar: (opts.store && opts.store.cookieJar) || '' };
  const consoleErrors = opts.captureConsoleErrors || [];

  const localStorageShim = {
    getItem(k) {
      if (opts.throwStorage) throw new Error('SecurityError: storage access blocked (simulated in-app webview)');
      return lsMap.has(k) ? lsMap.get(k) : null;
    },
    setItem(k, v) {
      if (opts.throwStorage) throw new Error('SecurityError: storage access blocked (simulated in-app webview)');
      lsMap.set(k, String(v));
    },
  };

  const locationShim = {
    search: opts.search || '',
    pathname: '/start',
    hash: opts.hash || '',
    protocol: opts.protocol || 'https:',
  };

  const documentShim = {
    get cookie() { return cookieState.jar; },
    set cookie(v) {
      // Real browsers merge one Set-Cookie directive into the jar by name;
      // replicate that (last write for a given name wins, matches Chrome).
      const name = String(v).split('=')[0];
      const parts = cookieState.jar.split('; ').filter(Boolean).filter((p) => p.split('=')[0] !== name);
      // A Max-Age=0 delete: drop it instead of re-adding.
      if (/;\s*max-age=0(\b|;)/i.test(v)) {
        cookieState.jar = parts.join('; ');
        return;
      }
      const nameValue = String(v).split(';')[0];
      parts.push(nameValue);
      cookieState.jar = parts.join('; ');
    },
  };

  let replacedUrl = null;
  const historyShim = {
    state: null,
    replaceState(state, title, url) {
      // gh-2074 fix round 2: models the SecurityError a real sandboxed
      // iframe (no allow-same-origin) or Safari's history-mutation rate
      // limit throws here. The head script wraps this call in its own
      // try/catch, so this throw is swallowed there — the point of Check 7
      // is to prove it is ALSO swallowed correctly, without leaking a
      // stale URL param into the second, independent variant read.
      if (opts.throwReplaceState) throw new Error('SecurityError: history.replaceState blocked (simulated sandboxed iframe / rate limit)');
      replacedUrl = url;
    },
  };

  const sandbox = {
    window: {
      location: locationShim,
      localStorage: localStorageShim,
    },
    document: documentShim,
    history: historyShim,
    URLSearchParams,
    Math,
    String,
    RegExp,
    console: {
      log: () => {},
      warn: (...a) => consoleErrors.push(['warn', ...a].join(' ')),
      error: (...a) => consoleErrors.push(['error', ...a].join(' ')),
    },
  };
  sandbox.window.document = documentShim;
  sandbox.window.history = historyShim;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  let threw = null;
  try {
    vm.runInContext(assignmentSrc, sandbox, { filename: 'start.html#gh-2033-assignment' });
  } catch (e) {
    threw = e;
  }

  return {
    threw,
    arm: sandbox.window.__oqVariant,
    replacedUrl,
    localStorageValue: (() => { try { return lsMap.get('oq_variant_v2') || null; } catch (e) { return null; } })(),
    cookieJar: cookieState.jar,
    cookieValue: (() => {
      const m = cookieState.jar.match(/(?:^|; )oq_variant_v2=([^;]*)/);
      return m ? m[1] : null;
    })(),
    lsMap,
    cookieJarRef: cookieState,
    consoleErrors,
    sandbox,
  };
}

/**
 * gh-2074 fix round 2 (PR #2079 review, Check 7): runs the head-inline
 * assignment script AND THEN the second, independent variant-read snippet
 * in the SAME sandbox/window — exactly how the two separate <script> tags
 * on a real page share one global `window`. Returns both the head script's
 * arm (window.__oqVariant) and the second read's own `variant`, so a
 * split-brain between them (the PR #2079 round-1 bug) is directly
 * observable as `arm !== variant`.
 */
function runFullPipeline(opts) {
  const head = runAssignment(opts);
  const sandbox = head.sandbox;
  let variant;
  let secondReadThrew = null;
  try {
    variant = vm.runInContext(
      '(function(){' + secondReadSrc + '\nreturn variant;\n})()',
      sandbox,
      { filename: 'start.html#gh-2074-second-read' }
    );
  } catch (e) {
    secondReadThrew = e;
  }
  return { arm: head.arm, variant, secondReadThrew, replacedUrl: head.replacedUrl };
}

// ── Check 1 + 2: 30 fresh (storage-cleared) loads, no ?v=, tally arms; the
// tally itself proves (2) is not simply pinned to one value for everyone,
// AND (gh-2074) that only LIVE_VARIANTS ever appears. ──
console.log('\n=== Check 1: 30 fresh loads, no ?v=, uniform-random tally across LIVE_VARIANTS ===');
const tally = { a: 0, b: 0, c: 0, d: 0, e: 0 };
const freshResults = [];
for (let i = 0; i < 30; i++) {
  const r = runAssignment({ search: '' });
  freshResults.push(r);
  if (r.arm && tally.hasOwnProperty(r.arm)) tally[r.arm]++;
}
console.log('Command: node tests/gh2033-variant-assignment.mjs (Check 1 block, 30x runAssignment({search:\'\'}) with a fresh Map()/cookie jar each call)');
console.log('LIVE_VARIANTS (read from start.html): ' + JSON.stringify(LIVE_VARIANTS));
console.log('Raw tally: a=' + tally.a + ' b=' + tally.b + ' c=' + tally.c + ' d=' + tally.d + ' e=' + tally.e + ' (n=30)');
const tallySum = tally.a + tally.b + tally.c + tally.d + tally.e;
ok(tallySum === 30, 'all 30 runs produced a valid, recognised arm');
ok(
  Object.keys(tally).filter((a) => tally[a] > 0).every((a) => LIVE_VARIANTS.includes(a)),
  'every arm observed across the 30 fresh loads is in LIVE_VARIANTS — gh-2074: a and b (and any other '
    + 'non-live arm) never appear in a fresh-load tally, no matter what LIVE_VARIANTS currently contains'
);
ok(tally.a === 0 && tally.b === 0, 'arm a and arm b specifically never appear in a fresh-load tally (gh-2074)');
ok(freshResults.every((r) => !r.threw), 'no run threw an uncaught exception');
ok(freshResults.every((r) => r.replacedUrl && new URL('https://x' + r.replacedUrl).searchParams.get('v') === r.arm),
  'every run rewrote the URL to /start?v=<its own assigned arm>');

// ── Check 2: reload in the SAME context (same localStorage Map + cookie
// jar) returns the SAME arm. Run against one of the 30 fresh sessions above
// so this is provably a real per-visitor store, not a shared default. ──
console.log('\n=== Check 2: reload in the same store returns the same arm ===');
const persistSeed = freshResults[0];
const sameStore = { localStorage: persistSeed.lsMap, cookieJar: persistSeed.cookieJarRef.jar };
const reload1 = runAssignment({ search: '', store: sameStore });
const reload2 = runAssignment({ search: '', store: { localStorage: reload1.lsMap, cookieJar: reload1.cookieJarRef.jar } });
console.log('First-session arm: ' + persistSeed.arm + ' | reload #1 arm: ' + reload1.arm + ' | reload #2 arm: ' + reload2.arm);
ok(reload1.arm === persistSeed.arm, 'reload #1 returns the same arm as the original session');
ok(reload2.arm === persistSeed.arm, 'reload #2 (localStorage-store read) returns the same arm again');

// ── Check 3: explicit ?v=c overrides a persisted 'a'. ──
console.log('\n=== Check 3: explicit override beats a persisted assignment ===');
const persistedA = new Map([['oq_variant_v2', 'a']]);
const overrideResult = runAssignment({ search: '?v=c', store: { localStorage: persistedA, cookieJar: 'oq_variant_v2=a' } });
console.log('Persisted arm going in: a | URL: /start?v=c | resulting arm: ' + overrideResult.arm + ' | rewritten URL: ' + overrideResult.replacedUrl);
ok(overrideResult.arm === 'c', '/start?v=c with a persisted "a" renders c');
ok(overrideResult.localStorageValue === 'c', 'the override also re-persists to localStorage as c (future loads stay on c)');

// ── Check 4: UTMs survive the rewrite, every other existing param intact. ──
console.log('\n=== Check 4: UTM / arbitrary params survive the URL rewrite ===');
const utmResult = runAssignment({ search: '?utm_source=fb&utm_campaign=x' });
console.log('Input search: ?utm_source=fb&utm_campaign=x | Output URL: ' + utmResult.replacedUrl);
const outParams = new URL('https://x' + utmResult.replacedUrl).searchParams;
ok(outParams.get('utm_source') === 'fb', 'utm_source=fb survived');
ok(outParams.get('utm_campaign') === 'x', 'utm_campaign=x survived');
ok(ARM_RE_TEST(outParams.get('v')), 'v=<arm> was appended');
console.log('leads-row half of Check 4 (a real form submission against production carrying these UTMs through '
  + 'to the leads table): NOT YET MEASURED by this harness — requires a live production submission, out of '
  + 'reach of a Node vm shim. Handing back to the orchestrator per the work order.');

function ARM_RE_TEST(v) { return /^[a-e]$/.test(String(v || '')); }

// ── Check 6: in-app webview — localStorage access THROWS throughout. ──
console.log('\n=== Check 6: localStorage throwing (Facebook in-app webview stand-in) ===');
const webviewErrors = [];
const webviewResult = runAssignment({ search: '', throwStorage: true, captureConsoleErrors: webviewErrors });
console.log('threw uncaught: ' + (webviewResult.threw ? webviewResult.threw.stack : 'none'));
console.log('assigned arm: ' + webviewResult.arm);
console.log('rewritten URL: ' + webviewResult.replacedUrl);
console.log('cookie jar after run: ' + JSON.stringify(webviewResult.cookieJar));
console.log('console output captured: ' + JSON.stringify(webviewErrors));
ok(webviewResult.threw === null, 'no uncaught exception reached the console/runtime with localStorage throwing');
ok(ARM_RE_TEST(webviewResult.arm), 'an arm was still assigned despite localStorage throwing');
ok(!!webviewResult.replacedUrl && ARM_RE_TEST(new URL('https://x' + webviewResult.replacedUrl).searchParams.get('v')),
  'the URL was still rewritten with a valid arm despite localStorage throwing');
ok(webviewResult.cookieValue === webviewResult.arm,
  'the cookie fallback still persisted the arm even though localStorage threw on every call');
ok(webviewErrors.length === 0, 'no console.warn/error was emitted (failures are silent per the try/catch design)');

// ── Negative control (§7.3b): the SAME allowlist rejects prototype-chain
// probes, shown beside a syntactically-valid-but-non-live arm (gh-2074:
// ?v=b must now be RE-MAPPED to a live arm, not rendered as "b"). ──
console.log('\n=== Negative control: ?v=constructor / ?v=__proto__ rejected, ?v=b re-mapped to a live arm ===');
const ctorResult = runAssignment({ search: '?v=constructor' });
const protoResult = runAssignment({ search: '?v=__proto__' });
const bResult = runAssignment({ search: '?v=b' });
console.log('/start?v=constructor -> assigned arm: ' + ctorResult.arm + ' (must be a live arm from fallback, never "constructor")');
console.log('/start?v=__proto__  -> assigned arm: ' + protoResult.arm + ' (must be a live arm from fallback, never "__proto__")');
console.log('/start?v=b          -> assigned arm: ' + bResult.arm + ' (must be a LIVE arm, never "b" — gh-2074)');
ok(ctorResult.arm !== 'constructor' && ARM_RE_TEST(ctorResult.arm) && LIVE_VARIANTS.includes(ctorResult.arm),
  '?v=constructor rejected — falls through to a live arm, never renders arm "constructor"');
ok(protoResult.arm !== '__proto__' && ARM_RE_TEST(protoResult.arm) && LIVE_VARIANTS.includes(protoResult.arm),
  '?v=__proto__ rejected — falls through to a live arm, never renders arm "__proto__"');
ok(bResult.arm !== 'b' && LIVE_VARIANTS.includes(bResult.arm),
  '?v=b (syntactically valid but NOT live) is re-mapped to a live arm and never rendered as "b" (gh-2074)');

// ── Check 7 (gh-2074 fix round 2, PR #2079 review): the split-brain
// regression. history.replaceState throwing must not let a stale,
// pre-mapped a/b from the URL win in the SECOND, independent variant read
// further down start.html — the head script's window.__oqVariant (already
// re-mapped to a live arm) must be what that second read reports too. This
// is the committed regression test for the bug PR #2079's round-2 fix
// closed; there was previously no committed test for it. ──
console.log('\n=== Check 7: split-brain regression — history.replaceState throwing must not leak a stale a/b into the second, independent variant read (gh-2074 fix round 2, PR #2079) ===');
const splitBrainA = runFullPipeline({ search: '?v=a', throwReplaceState: true });
const splitBrainB = runFullPipeline({ search: '?v=b', throwReplaceState: true });
console.log('/start?v=a with replaceState throwing -> head arm (window.__oqVariant): ' + splitBrainA.arm
  + ' | second-read variant: ' + splitBrainA.variant
  + ' | second read threw: ' + (splitBrainA.secondReadThrew ? splitBrainA.secondReadThrew.message : 'no'));
console.log('/start?v=b with replaceState throwing -> head arm (window.__oqVariant): ' + splitBrainB.arm
  + ' | second-read variant: ' + splitBrainB.variant
  + ' | second read threw: ' + (splitBrainB.secondReadThrew ? splitBrainB.secondReadThrew.message : 'no'));
ok(splitBrainA.secondReadThrew === null, '?v=a + replaceState throwing: the second-read snippet itself runs without throwing');
ok(splitBrainB.secondReadThrew === null, '?v=b + replaceState throwing: the second-read snippet itself runs without throwing');
ok(LIVE_VARIANTS.includes(splitBrainA.arm), '?v=a + replaceState throwing: head script still assigns a live arm despite the throw');
ok(LIVE_VARIANTS.includes(splitBrainB.arm), '?v=b + replaceState throwing: head script still assigns a live arm despite the throw');
ok(splitBrainA.variant === splitBrainA.arm,
  '?v=a + replaceState throwing: the second, independent variant read agrees with the head arm — no split-brain');
ok(splitBrainB.variant === splitBrainB.arm,
  '?v=b + replaceState throwing: the second, independent variant read agrees with the head arm — no split-brain');
// Today's LIVE_VARIANTS is exactly ['c'], so this is deterministic; pinned
// literally per the PR #2079 round-2 review's own required test ("must
// yield variant='c'"), alongside the more general LIVE_VARIANTS-based
// checks above so this keeps working once LIVE_VARIANTS grows.
if (LIVE_VARIANTS.length === 1) {
  ok(splitBrainA.variant === LIVE_VARIANTS[0],
    '?v=a + replaceState throwing yields variant="' + LIVE_VARIANTS[0] + '" (today\'s single-live-arm LIVE_VARIANTS)');
  ok(splitBrainB.variant === LIVE_VARIANTS[0],
    '?v=b + replaceState throwing yields variant="' + LIVE_VARIANTS[0] + '" (today\'s single-live-arm LIVE_VARIANTS)');
}

console.log('\n=== Summary ===');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
