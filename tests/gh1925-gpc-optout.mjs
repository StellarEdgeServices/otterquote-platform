/**
 * gh-1925 -- CCPA/CPRA "Do Not Sell or Share" via Global Privacy Control, extended to the STATIC gates that did not yet
 * honour it: js/ga-gate.js (GA4, which carries Google Ads/Signals once linked; Clarity is deliberately left ungated -- see
 * PR body), js/linkedin-insight-gate.js and js/reddit-pixel-gate.js (both shipped dark by #2102). js/meta-pixel-gate.js
 * already honours this (gh-2107 / D-330); this proves the other three now do too, using the SAME oq_ad_optout cookie.
 *
 * Runs the REAL js/ files in a vm context with a fake window, document, navigator and cookie jar, and asserts whether the
 * vendor <script> is ever inserted. js/linkedin-insight-gate.js and js/reddit-pixel-gate.js ship dark (their real IDs are
 * empty-string placeholders, #1926) -- to prove the opt-out mechanism itself, not just the dark no-op, this harness swaps
 * the empty placeholder for a throwaway TEST_* id before executing the source in vm, the same technique PR #2102's own
 * positive-control test used ("a throwaway scratchpad fixture with only the placeholder ID swapped for a TEST_* stand-in").
 * The real shipped files are never modified by this file -- only an in-memory copy of their source text is.
 *
 * Run: node tests/gh1925-gpc-optout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, '..', 'js');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function makeCtx({ host = 'otterquote.com', gpc, cookie = '', hash = '', search = '', pathname = '/' } = {}) {
  const appended = [];
  const cookieWrites = [];
  let jar = cookie;
  const doc = {
    get cookie() { return jar; },
    set cookie(v) { cookieWrites.push(v); const [kv] = v.split(';'); const [k] = kv.split('='); const rest = jar.split('; ').filter((c) => c && !c.startsWith(k + '=')); rest.push(kv); jar = rest.join('; '); },
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
    documentElement: {},
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => appended.push(el) } }],
  };
  const win = {
    location: { hostname: host, hash, search, pathname },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; }, // run the idle load immediately
    cancelIdleCallback() {},
  };
  const nav = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  function FakeMutationObserver() { return { observe() {} }; }
  const ctx = { window: win, document: doc, navigator: nav, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, MutationObserver: FakeMutationObserver };
  win.window = win;
  vm.createContext(ctx);
  return { ctx, win, doc, appended, cookieWrites };
}

function appendedCount(appended, urlSubstr) {
  return appended.filter((e) => e.tag === 'script' && String(e.src).indexOf(urlSubstr) !== -1).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// js/ga-gate.js -- GA4 honours the opt-out; Clarity does not (by design, see PR body).
// ---------------------------------------------------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(JS_DIR, 'ga-gate.js'), 'utf8');
  function run(opts) {
    const { ctx, appended, cookieWrites } = makeCtx(opts);
    vm.runInContext(src, ctx);
    return {
      ga4Loaded: appendedCount(appended, 'googletagmanager.com/gtag/js') === 1,
      clarityLoaded: appendedCount(appended, 'clarity.ms/tag/') === 1,
      cookieWrites,
      gtag: ctx.window.gtag,
    };
  }

  {
    const r = run({});
    ok(r.ga4Loaded, 'CONTROL: an ordinary visitor on otterquote.com loads gtag.js exactly once');
    ok(typeof r.gtag === 'function', 'CONTROL: gtag is defined');
  }
  {
    const r = run({ gpc: true });
    ok(!r.ga4Loaded, 'GPC on: gtag.js is NOT loaded');
    ok(r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1')), 'GPC on: the shared oq_ad_optout cookie is left behind');
    ok(r.cookieWrites.some((w) => /Domain=\.otterquote\.com/.test(w) && /Max-Age=31536000/.test(w)), 'the cookie is scoped to .otterquote.com for one year (the same shape as oq_internal / meta-pixel-gate.js)');
    let threw = false; try { r.gtag('config', 'G-D1Y1TLGEFY'); } catch (e) { threw = true; }
    ok(!threw, 'GPC on: an existing gtag(...) call site does not throw');
  }
  {
    const r = run({ cookie: 'oq_ad_optout=1' });
    ok(!r.ga4Loaded, 'the oq_ad_optout cookie alone (no GPC) keeps gtag.js off');
    ok(r.cookieWrites.length === 0, 'no cookie is rewritten when it is already there');
  }
  for (const [label, opts] of [['GPC false', { gpc: false }], ['GPC undefined', {}], ['GPC "true" (a string)', { gpc: 'true' }], ['cookie 0', { cookie: 'oq_ad_optout=0' }]]) {
    const r = run(opts);
    ok(r.ga4Loaded, label + ': not an opt-out, GA4 loads');
  }
  ok(!run({ host: 'staging--jade-alpaca-b82b5e.netlify.app' }).ga4Loaded, 'a non-production host still never loads GA4');
  ok(!run({ search: '?oq_internal=1' }).ga4Loaded, 'internal traffic still never loads GA4');
  // The point of this PR: Clarity is a SEPARATE vendor and is deliberately left out of the opt-out (see PR body / #1925 Q comment).
  {
    const r = run({ gpc: true, host: 'otterquote.com', search: '' });
    // Clarity additionally requires an allowlisted path; '/' is on CLARITY_ALLOWED_PATHS.
    ok(r.clarityLoaded, 'DELIBERATE SCOPE: GPC on does NOT stop Clarity from loading (Clarity is not named as an "ad-tech tag" in #1925; see PR body for the open legal question)');
  }
  // a broken environment must not break the page or wrongly opt anyone out
  {
    const { ctx, appended } = makeCtx({});
    Object.defineProperty(ctx.navigator, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
    let threw = false; try { vm.runInContext(src, ctx); } catch (e) { threw = true; }
    ok(!threw, 'a navigator whose globalPrivacyControl getter throws does not break the page');
    ok(appendedCount(appended, 'googletagmanager.com/gtag/js') === 1, 'GA4 still loads normally when the GPC getter throws (fails open on GPC read error, matching js/meta-pixel-gate.js)');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// js/linkedin-insight-gate.js and js/reddit-pixel-gate.js -- both shipped dark (#1926/#2102). The placeholder empty ID is
// swapped for a throwaway TEST_* id in this in-memory copy only, to exercise the opt-out mechanism end to end.
// ---------------------------------------------------------------------------------------------------------------------
function testDarkGate({ file, idDecl, testIdDecl, vendorUrlSubstr, stubName, label }) {
  const rawSrc = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
  ok(rawSrc.indexOf(idDecl) !== -1, label + ': the expected placeholder declaration is present in the real shipped file (' + file + ')');
  const src = rawSrc.replace(idDecl, testIdDecl);
  ok(src !== rawSrc, label + ': the in-memory TEST id swap took effect');

  function run(opts) {
    const { ctx, appended, cookieWrites } = makeCtx(opts);
    vm.runInContext(src, ctx);
    return { loaded: appendedCount(appended, vendorUrlSubstr) === 1, cookieWrites, stub: ctx.window[stubName] };
  }

  {
    const r = run({});
    ok(r.loaded, label + ' CONTROL (TEST id): an ordinary visitor on otterquote.com loads the vendor script exactly once');
  }
  {
    const r = run({ gpc: true });
    ok(!r.loaded, label + ' GPC on (TEST id): the vendor script is NOT loaded');
    ok(r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1')), label + ' GPC on: the shared oq_ad_optout cookie is left behind');
  }
  {
    const r = run({ cookie: 'oq_ad_optout=1' });
    ok(!r.loaded, label + ': the oq_ad_optout cookie alone (no GPC) keeps the vendor script off');
  }
  ok(run({ gpc: false }).loaded, label + ': GPC false is not an opt-out, the vendor script loads');
  ok(!run({ search: '?oq_internal=1' }).loaded, label + ': internal traffic still never loads the vendor script');
  ok(!run({ host: 'staging--jade-alpaca-b82b5e.netlify.app' }).loaded, label + ': a non-production host still never loads the vendor script');

  // Also confirm the REAL shipped file (empty id) is still a complete no-op regardless of GPC -- the dark merge is untouched.
  function runReal(opts) {
    const { ctx, appended } = makeCtx(opts);
    vm.runInContext(rawSrc, ctx);
    return appendedCount(appended, vendorUrlSubstr) === 0;
  }
  ok(runReal({ gpc: true }), label + ': the REAL shipped file (empty id) is still a complete no-op with GPC on');
  ok(runReal({}), label + ': the REAL shipped file (empty id) is still a complete no-op with no GPC');
}

testDarkGate({
  file: 'linkedin-insight-gate.js',
  idDecl: "var LINKEDIN_PARTNER_ID = '';",
  testIdDecl: "var LINKEDIN_PARTNER_ID = 'TEST_PARTNER_ID';",
  vendorUrlSubstr: 'snap.licdn.com',
  stubName: 'lintrk',
  label: 'LinkedIn Insight Tag gate',
});

testDarkGate({
  file: 'reddit-pixel-gate.js',
  idDecl: "var REDDIT_PIXEL_ID = '';",
  testIdDecl: "var REDDIT_PIXEL_ID = 'TEST_PIXEL_ID';",
  vendorUrlSubstr: 'redditstatic.com',
  stubName: 'rdt',
  label: 'Reddit Pixel gate',
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
