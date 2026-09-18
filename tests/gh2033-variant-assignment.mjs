/**
 * gh-2033 — /start assigns the A/B/C variant itself.
 *
 * No real browser engine (playwright/puppeteer) or jsdom is present in this
 * repo's node_modules or package.json, and no such dependency was added for
 * this harness (checked first, per the work order). Following the existing
 * pattern in tests/cookie-max-age-400-days.mjs, this loads the ACTUAL
 * inline assignment script — extracted verbatim from start.html's <head>,
 * not reimplemented — into a Node `vm` context behind a minimal DOM shim
 * (window.location, document.cookie, window.localStorage, history).
 *
 * LABEL: this is a Node `vm` + DOM-shim result, NOT a real-browser result.
 * It proves the extracted script's own logic under each scenario; it does
 * not prove real Chrome/WebKit/Facebook-in-app-webview behavior. Checks
 * 4's "leads-row" half and check 5 (GA4 attribution) are out of this
 * harness's reach entirely and are reported separately as NOT YET MEASURED
 * / handled by the orchestrator.
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

// Extract the gh-2033 inline assignment script verbatim: the first
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

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

/**
 * Build a fresh sandbox and run the extracted assignment script in it.
 * @param {object} opts
 *   search: URL query string incl leading '?', e.g. '?v=c'
 *   protocol: 'https:' | 'http:'
 *   store: pre-seeded { localStorage: Map, cookies: {} } for persistence tests
 *   throwStorage: if true, localStorage.getItem/setItem throw (webview case)
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
    replaceState(state, title, url) { replacedUrl = url; },
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
    localStorageValue: (() => { try { return lsMap.get('oq_variant_v1') || null; } catch (e) { return null; } })(),
    cookieJar: cookieState.jar,
    cookieValue: (() => {
      const m = cookieState.jar.match(/(?:^|; )oq_variant_v1=([^;]*)/);
      return m ? m[1] : null;
    })(),
    lsMap,
    cookieJarRef: cookieState,
    consoleErrors,
  };
}

// ── Check 1 + 2: 30 fresh (storage-cleared) loads, no ?v=, tally arms; the
// tally itself proves (2) is not simply pinned to one value for everyone. ──
console.log('\n=== Check 1: 30 fresh loads, no ?v=, uniform-random tally ===');
const tally = { a: 0, b: 0, c: 0 };
const freshResults = [];
for (let i = 0; i < 30; i++) {
  const r = runAssignment({ search: '' });
  freshResults.push(r);
  if (r.arm && tally.hasOwnProperty(r.arm)) tally[r.arm]++;
}
console.log('Command: node tests/gh2033-variant-assignment.mjs (Check 1 block, 30x runAssignment({search:\'\'}) with a fresh Map()/cookie jar each call)');
console.log('Raw tally: a=' + tally.a + ' b=' + tally.b + ' c=' + tally.c + ' (n=30)');
ok(tally.a + tally.b + tally.c === 30, 'all 30 runs produced a valid arm');
ok(tally.a > 0 && tally.b > 0 && tally.c > 0, 'all three arms appeared at least once (none absent)');
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
const persistedA = new Map([['oq_variant_v1', 'a']]);
const overrideResult = runAssignment({ search: '?v=c', store: { localStorage: persistedA, cookieJar: 'oq_variant_v1=a' } });
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

function ARM_RE_TEST(v) { return /^[abc]$/.test(String(v || '')); }

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
// probes, shown beside an accepted arm. ──
console.log('\n=== Negative control: ?v=constructor / ?v=__proto__ rejected, ?v=b accepted ===');
const ctorResult = runAssignment({ search: '?v=constructor' });
const protoResult = runAssignment({ search: '?v=__proto__' });
const bResult = runAssignment({ search: '?v=b' });
console.log('/start?v=constructor -> assigned arm: ' + ctorResult.arm + ' (must be a/b/c from fallback, never "constructor")');
console.log('/start?v=__proto__  -> assigned arm: ' + protoResult.arm + ' (must be a/b/c from fallback, never "__proto__")');
console.log('/start?v=b          -> assigned arm: ' + bResult.arm + ' (must be exactly "b")');
ok(ctorResult.arm !== 'constructor' && ARM_RE_TEST(ctorResult.arm), '?v=constructor rejected — falls through to random a/b/c, never renders arm "constructor"');
ok(protoResult.arm !== '__proto__' && ARM_RE_TEST(protoResult.arm), '?v=__proto__ rejected — falls through to random a/b/c, never renders arm "__proto__"');
ok(bResult.arm === 'b', '?v=b (a real allowlisted arm) is accepted and renders exactly "b"');

console.log('\n=== Summary ===');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
