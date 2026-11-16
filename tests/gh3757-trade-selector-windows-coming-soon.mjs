/**
 * gh-3757 / D-375 -- trade-selector.html: the Windows card carries the generic "Coming Soon" badge
 * (same markup/text as contractor-auto-bids.html) and cannot be selected. Executes the page's inline
 * script in a minimal DOM stub: a click on the Windows card must leave state.trades without 'windows'.
 * Run: node tests/gh3757-trade-selector-windows-coming-soon.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.env.GH3757_PAGE || path.join(root, 'trade-selector.html'), 'utf8');
const auto = fs.readFileSync(path.join(root, 'contractor-auto-bids.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, l) { if (c) { console.log('PASS: ' + l); pass++; } else { console.log('FAIL: ' + l); fail++; } }

const badge = '<span class="badge coming-soon">Coming Soon</span>';
ok(auto.includes(badge), 'reference badge exists on contractor-auto-bids.html');
const card = html.match(/<div class="trade-card"[^>]*id="trade-windows"[^>]*>[\s\S]*?<\/h3>(\s*<span[^>]*>[^<]*<\/span>)?/);
const cardSrc = card ? card[0] : '';
ok(cardSrc.includes(badge), 'Windows card contains the identical Coming Soon badge markup');
ok(/aria-disabled="true"/.test(cardSrc), 'Windows card has aria-disabled="true"');
for (const t of ['roofing', 'siding', 'gutters']) {
  const c = html.match(new RegExp('<div class="trade-card"[^>]*id="trade-' + t + '"[^>]*>[\\s\\S]*?</h3>(\\s*<span[^>]*>[^<]*</span>)?'));
  ok(c && !/aria-disabled|Coming Soon/.test(c[0]), t + ' card is not marked');
}

// Execute the inline trade-selection script against a stub DOM.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts.find(s => s.includes("const TRADES = ["));
ok(!!main, 'found inline script with TRADES');
const els = {};
function el(id) {
  if (els[id]) return els[id];
  const attrs = {};
  if (id === 'trade-windows' && /aria-disabled="true"/.test(cardSrc)) attrs['aria-disabled'] = 'true';
  const listeners = {};
  els[id] = {
    id, attrs, listeners, disabled: false, textContent: '', value: '', style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    setAttribute(k, v) { attrs[k] = v; },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    appendChild() {}, querySelector: () => el('x'), querySelectorAll: () => [], focus() {}, click() {},
  };
  return els[id];
}
const doc = { getElementById: el, querySelector: () => el('q'), querySelectorAll: () => [], addEventListener() {}, createElement: () => el('c'), body: el('body'), documentElement: el('html') };
const ctx = { document: doc, window: {}, console, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { href: '', search: '' }, URLSearchParams, setTimeout() {}, fetch: () => Promise.reject(new Error('stub')), navigator: {} };
ctx.window = ctx;
vm.createContext(ctx);
let ran = true;
try { vm.runInContext(main + '\n;globalThis.__state = state;', ctx); } catch (e) { ran = false; console.log('script error: ' + e.message); }
ok(ran, 'inline script executed in stub DOM');
if (ran) {
  for (const l of els['trade-windows'].listeners.click || []) l();
  ok(!ctx.__state.trades.includes('windows'), 'click on Windows card leaves state.trades without "windows"');
  ok(els['step-trades-continue'].disabled === true || ctx.__state.trades.length === 0, 'Continue stays disabled after clicking Windows');
  for (const l of els['trade-gutters'].listeners.click || []) l();
  ok(ctx.__state.trades.includes('gutters'), 'control: click on Gutters card still selects it');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
