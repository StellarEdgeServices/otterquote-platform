/**
 * gh-2905 -- roofing bid comparison tool: stale-state check for the storage key
 * "oq-bidtool-v1" (storage-surface ledger, tests/fixtures/gh2060-storage-surface-ledger.json).
 * Runs the REAL inline script of guides/roof-bid-comparison-tool.html under node:vm against a
 * minimal DOM shim, seeds localStorage with malformed saved states and asserts the page never
 * throws and ends up with a valid state. No browser needed.
 * Run: node tests/gh2905-bidtool-stale-state.mjs   (exit 1 on any failure)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'guides/roof-bid-comparison-tool.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("oq-bidtool-v1"));
let fails = 0;
const ok = (c, l) => { if (!c) fails++; console.log(`${c ? '✓ PASS' : '✗ FAIL'}: ${l}`); };
ok(!!script, 'inline tool script found');

function run(saved, { throwStorage = false } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', hidden: false, dataset: {}, scrollIntoView() {} });
  const store = { ...(saved === undefined ? {} : { 'oq-bidtool-v1': saved }) };
  const window = {};
  const ctx = {
    window,
    document: { getElementById: el, addEventListener() {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: throwStorage ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console, Date, Math, JSON, parseFloat, isNaN, isFinite, Array, Object, String, Number, setTimeout, clearTimeout,
  };
  ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  let err = null;
  try { vm.runInContext(script, ctx); } catch (e) { err = e; }
  return { err, state: window.__oqBid && window.__oqBid.state(), els };
}
const KEYS = ['wind', 'class4', 'algae', 'labor', 'mfgdef', 'mfglabor', 'tearoff', 'iws', 'drip', 'ridge', 'permit', 'disposal'];
function valid(st) {
  return st && Array.isArray(st.c) && st.c.length > 0 && st.c.every((c) =>
    c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.price === 'string' && Array.isArray(c.custom) &&
    KEYS.every((k) => c.items && c.items[k] && typeof c.items[k].on === 'boolean' && typeof c.items[k].v === 'string') &&
    c.custom.every((x) => typeof x.k === 'string' && typeof x.label === 'string' && typeof x.on === 'boolean'));
}
const bad = {
  'no items': { n: 1, c: [{ id: 'a', name: 'A', price: '', custom: [] }] },
  'items holding only wind (older schema)': { n: 1, c: [{ id: 'a', name: 'A', price: '', items: { wind: { on: true, v: '130' } }, custom: [] }] },
  'custom null': { n: 1, c: [{ id: 'a', name: 'A', price: '', items: {}, custom: null }] },
  'c holds null': { n: 1, c: [null] },
  'not json': '{oops',
  'wrong top-level types': { n: 'x', c: 'nope' },
  'c holds primitives': { n: 2, c: [1, 'x', [], true] },
};
for (const [label, v] of Object.entries(bad)) {
  const r = run(typeof v === 'string' ? v : JSON.stringify(v));
  ok(!r.err && valid(r.state), `malformed saved state never throws and falls back to a fresh state: ${label}`);
}
// the older-schema case keeps what is valid
const old = run(JSON.stringify(bad['items holding only wind (older schema)']));
ok(old.state.c.length === 1 && old.state.c[0].items.wind.on === true && old.state.c[0].items.wind.v === '130' && old.state.c[0].items.class4.on === false, 'older-schema state keeps valid entries and fills every missing key');
const good = run(JSON.stringify({ n: 3, c: [{ id: 'z', name: 'Zed', price: '$9', items: Object.fromEntries(KEYS.map((k) => [k, { on: true, v: '' }])), custom: [{ k: 'x1', label: 'Gutters', on: true, v: '' }] }] }));
ok(valid(good.state) && good.state.c[0].name === 'Zed' && good.state.c[0].custom.length === 1, 'a valid saved state round-trips unchanged');
const fresh = run(undefined);
ok(valid(fresh.state) && fresh.state.c.length === 2, 'no saved state starts with two fresh cards');
const thr = run(undefined, { throwStorage: true });
ok(!thr.err && valid(thr.state), 'localStorage that throws leaves a working fresh state');
ok(!/window\.confirm/.test(script) && !/dataLayer/.test(script) && /gtag\('event'/.test(script), 'no window.confirm; analytics via gtag(event)');
console.log(fails ? `\n✗ ${fails} failure(s)` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
