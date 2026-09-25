#!/usr/bin/env node
// gh-1964 artifact 3 (partial, static-CI shape): a runtime negative control
// for the Clarity page-set gate in js/ga-gate.js.
//
// scripts/check-clarity-page-gate.py already proves, statically, that no
// authenticated page's path is present in CLARITY_ALLOWED_PATHS. This check
// proves something check-clarity-page-gate.py cannot: that js/ga-gate.js's
// *actual control flow*, executed, really does stop short of inserting the
// Clarity <script src="https://www.clarity.ms/tag/..."> element on an
// authenticated page's URL, and really does insert it on a public page's
// URL. It is a same-process negative control (no network, no browser, no
// deploy) -- the deployed-and-live headless-browser probe against
// production (gh-1964 closes-on artifact 3, "a headless-browser probe
// against a deployed authenticated page") is a separate, still-open step;
// this check is what CI can run on every PR in the meantime, and it is not
// a substitute for that post-deploy probe.
//
// No dependencies (no jsdom): js/ga-gate.js only touches a small, fixed
// surface of the DOM/BOM (document.createElement/head/getElementsByTagName,
// window.location/addEventListener, document.cookie, URLSearchParams), so a
// hand-rolled stub of exactly that surface is enough to execute the real
// file unmodified and observe what it does.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(repoRoot, 'js', 'ga-gate.js'), 'utf8');

function makeElement(tag) {
  const el = {
    tagName: tag,
    _attrs: {},
    children: [],
    parentNode: null,
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    hasAttribute(k) { return k in this._attrs; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(node, ref) {
      const idx = this.children.indexOf(ref);
      this.children.splice(idx === -1 ? this.children.length : idx, 0, node);
      node.parentNode = this;
      return node;
    },
    matches() { return false; },
    querySelectorAll() { return []; },
    nodeType: 1,
  };
  Object.defineProperty(el, 'src', {
    get() { return this._attrs.src; },
    set(v) { this._attrs.src = v; },
  });
  return el;
}

// Runs js/ga-gate.js, as-is, against a simulated hostname+pathname, and
// returns every <script> src the file inserted into <head>.
function runGateFor(hostname, pathname) {
  const headEl = makeElement('head');
  const firstScript = makeElement('script');
  headEl.appendChild(firstScript);

  const listeners = {};
  function addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  function removeEventListener(type, fn) {
    if (listeners[type]) listeners[type] = listeners[type].filter((l) => l !== fn);
  }
  function dispatch(type) { (listeners[type] || []).slice().forEach((fn) => fn()); }

  let cookieStr = '';
  const documentStub = {
    head: headEl,
    documentElement: makeElement('html'),
    createElement(tag) { return makeElement(tag); },
    getElementsByTagName(tag) { return tag === 'script' ? [firstScript] : []; },
    addEventListener() {}, // DOMContentLoaded listener for the mask-tagger; not exercised here
    get cookie() { return cookieStr; },
    set cookie(v) { cookieStr += (cookieStr ? '; ' : '') + v; },
  };

  const sandbox = {
    document: documentStub,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox; // a real browser's `window` is its own global object
  sandbox.window.location = { hostname, pathname, hash: '', search: '' };
  sandbox.window.addEventListener = addEventListener;
  sandbox.window.removeEventListener = removeEventListener;
  // requestIdleCallback intentionally left undefined -> ga-gate.js falls
  // back to setTimeout(run, 1500); dispatch('scroll') below fires `run()`
  // first (via the real 'scroll' listener ga-gate.js itself registers), so
  // the 1500ms timer is cleared and this script never has to wait for it.

  vm.createContext(sandbox);
  vm.runInContext(gateSrc, sandbox, { filename: 'js/ga-gate.js' });

  // Fire the same interaction ga-gate.js itself listens for
  // (_oqLoadOnIdleOrInteraction's EVENTS list includes 'scroll') so both the
  // GA4 and the Clarity vendor-script insertions run synchronously instead
  // of waiting on a real idle callback or a 1500ms timer.
  dispatch('scroll');

  const srcs = [];
  (function walk(el) {
    if (el.tagName === 'script' && el._attrs.src) srcs.push(el._attrs.src);
    (el.children || []).forEach(walk);
  })(headEl);
  return srcs;
}

const CLARITY_HOST = 'clarity.ms/tag';
const cases = [
  { name: 'PUBLIC  /             (marketing home)', hostname: 'otterquote.com', pathname: '/', expectClarity: true },
  { name: 'PUBLIC  /blog         (marketing blog index)', hostname: 'otterquote.com', pathname: '/blog', expectClarity: true },
  { name: 'AUTH    /contractor-profile.html', hostname: 'otterquote.com', pathname: '/contractor-profile.html', expectClarity: false },
  { name: 'AUTH    /admin-payouts.html', hostname: 'otterquote.com', pathname: '/admin-payouts.html', expectClarity: false },
  { name: 'AUTH    /partner-dashboard.html', hostname: 'otterquote.com', pathname: '/partner-dashboard.html', expectClarity: false },
  // gh-1964 should-fix (test coverage): an extensionless pathname, not
  // just a '.html'-stripped one -- normalizeClarityPath's slice(-5)==='.html'
  // branch is a no-op here, so this exercises the allowlist match on the
  // path exactly as CLARITY_ALLOWED_PATHS stores it.
  { name: 'AUTH-RULED /bids (extensionless)', hostname: 'otterquote.com', pathname: '/bids', expectClarity: true },
  // gh-1964 should-fix (test coverage): a masked AUTH-RULED page --
  // contractor-about.html carries data-clarity-mask="true" (gh-1939 scope
  // extension) and IS on CLARITY_ALLOWED_PATHS, unlike the plain AUTH
  // cases above. This confirms the gate lets Clarity load there (the
  // masking itself is enforced by check-clarity-page-gate.py's
  // RULED_AUTHENTICATED_ALLOWED check on the page's own markup, not by
  // this runtime control).
  { name: 'AUTH-RULED /contractor-about.html (masked)', hostname: 'otterquote.com', pathname: '/contractor-about.html', expectClarity: true },
];

let failures = 0;
const lines = [];
for (const c of cases) {
  const srcs = runGateFor(c.hostname, c.pathname);
  const gotClarity = srcs.some((s) => s.indexOf(CLARITY_HOST) !== -1);
  const ok = gotClarity === c.expectClarity;
  if (!ok) failures++;
  lines.push(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name}  clarity.ms request: ${gotClarity ? 'YES' : 'no'}  (expected ${c.expectClarity ? 'YES' : 'no'})`
  );
}

console.log(lines.join('\n'));
if (failures > 0) {
  console.log(`\ncheck-clarity-runtime-negative-control: FAIL -- ${failures} case(s) did not match the expected clarity.ms request behaviour`);
  process.exit(1);
} else {
  console.log('\ncheck-clarity-runtime-negative-control: OK -- executed js/ga-gate.js unmodified; clarity.ms is requested on public pages and not on authenticated pages');
  process.exit(0);
}
