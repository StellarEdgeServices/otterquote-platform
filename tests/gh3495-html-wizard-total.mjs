// gh-3495 (D-267): the STATIC bid form's multi-trade (wizard) money path.
// Runs the real functions from contractor-bid-form.html in a node:vm sandbox over a stub DOM
// (no browser, no deps). Proves F1 (fee shown + accepted follow the sum, also on step 3 and at
// submit), F2 (Change Bid on a stored wizard bid does not double-count) and F3 (one decimal-safe
// rounding for Grand Total, stored total and breakdown).
//   node tests/gh3495-html-wizard-total.mjs            (HTML_PATH=<file> to test another copy)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HTML = readFileSync(process.env.HTML_PATH || new URL('../contractor-bid-form.html', import.meta.url), 'utf8');

// ---- pull a top-level function's source out of the page script (brace matching) ----
function grab(name) {
  const m = new RegExp(`^    (async )?function ${name}\\(`, 'm').exec(HTML);
  if (!m) return null;
  const i = HTML.indexOf('{', HTML.indexOf(')', m.index));
  let depth = 0;
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) return HTML.slice(m.index, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
const REAL = ['_priceToCents', '_sidingTotalNow', '_liveTradePrice', 'effectiveBidAmount', 'roundedTradePrices',
  '_applyStoredBreakdown', 'captureCurrentTradePrice', 'buildWizardSummary', 'wizardGoTo', 'wizardNext', 'wizardBack',
  'updateFeeCalculator', 'updateFeeDisclosure', 'formatCurrency', 'setVal', 'syncSidingTotal'];

function sandbox() {
  const els = {};
  const mk = (id) => ({ id, value: '', textContent: '', innerHTML: '', style: {}, checked: false, listeners: {},
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, setProperty() {}, scrollIntoView() {},
    classList: { add() {}, remove() {} } });
  const document = {
    getElementById: (id) => (els[id] ||= mk(id)),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const ctx = vm.createContext({ document, window: {}, console, Intl, Math, parseFloat, parseInt, Number, isFinite, Promise,
    history: { pushState() {}, replaceState() {} }, location: { href: '' }, setTimeout });
  vm.runInContext(`
    let wizardMode = true, wizardStep = 2, wizardCurrentTradeIdx = 0, wizardTradeQueue = ['roofing','gutters'];
    let wizardTradePrices = {}, sidingWallSquares = null, sidingTradeActive = false, _feeAcceptanceCheckbox = null, _submitBtn = null;
    let _platformFeePct = 5;
    const PLATFORM_FEES = { contractSigning: 0.05 };
    async function fetchPlatformFeePercentage() { return 5; }
    function _showWizardTrade() {} function _updateWizardProgressBar() {} function saveWizardState() {}
    function updateFeeCheckboxState() {}
    function updateSlcDisclosure() {}`, ctx);
  const have = [];
  for (const n of REAL) { const src = grab(n); if (src) { vm.runInContext(src, ctx); have.push(n); } }
  return { ctx, els, document, have, el: (id) => document.getElementById(id), run: (code) => vm.runInContext(code, ctx) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const money = (s) => Number(String(s).replace(/[$,]/g, ''));
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
}

await t('F3: decimal-safe cents, one rounding (9734.095 -> 973410; 1000 + 200.015 shown == stored)', () => {
  const s = sandbox();
  assert.ok(s.have.includes('_priceToCents'), '_priceToCents missing');
  for (const [raw, c] of [['9734.095', 973410], ['1.005', 101], ['2.675', 268], ['0.004', 0], ['200.015', 20002]]) {
    assert.equal(s.ctx._priceToCents(raw), c, raw);
  }
  s.run('wizardStep = 3; wizardTradePrices = { roofing: 1000, gutters: 200.015 };');
  s.run('buildWizardSummary()');
  assert.equal(money(s.el('wizardGrandTotal').textContent), 1200.02, 'Grand Total shown');
  assert.equal(s.run('effectiveBidAmount()'), 1200.02, 'stored total');
  assert.deepEqual(JSON.parse(JSON.stringify(s.run('roundedTradePrices()'))), { roofing: 1000, gutters: 200.02 });
});

await t('F1: roofing 10000 + gutters 2000 typed with no input events -> step 3 fee box, disclosure and accepted fee are 600 (5% of 12000)', async () => {
  const s = sandbox();
  s.run('wizardGoTo(2, 0, false)');
  s.el('retailBidPrice').value = '10000';
  s.run('wizardNext()');                       // captures roofing, moves to gutters
  s.el('gutter6InchPrice').value = '2000';     // gutter inputs have no listener in a wizard
  s.run('wizardNext()');                       // captures gutters, enters step 3
  await flush();
  assert.equal(s.run('wizardStep'), 3);
  assert.equal(money(s.el('wizardGrandTotal').textContent), 12000, 'Grand Total');
  assert.equal(money(s.el('totalFeeAmount').textContent), 600, 'fee box');
  assert.equal(money(s.el('feeDollarDisplay').textContent), 600, 'fee disclosure');
  assert.equal(money(s.el('feeDollarCheckbox').textContent), 600, 'fee the contractor ticks');
  assert.equal(s.ctx.window._feeAmount, 600, 'accepted fee amount');
  assert.equal(s.run('effectiveBidAmount()'), 12000, 'stored total_price');
});

await t('F1: submit refreshes the disclosure BEFORE capturing _feeAmount / _exactFeeText', () => {
  const cap = HTML.indexOf('const _feeAmount = window._feeAmount');
  assert.ok(cap > 0);
  assert.ok(/await updateFeeDisclosure\(\);/.test(HTML.slice(Math.max(0, cap - 900), cap)),
    'no await updateFeeDisclosure() before the fee capture');
});

await t('F1: wizard price inputs (gutters) refresh the fee on input', () => {
  assert.ok(/\['retailBidPrice', 'gutter5InchPrice', 'gutter6InchPrice'\]\.forEach/.test(HTML), 'initWizard wiring missing');
});

await t('F2: Change Bid click-through on a stored $12,000 (10,000 + 2,000) wizard bid stores 12,000, not 14,000', async () => {
  const s = sandbox();
  // What populate does on a stored wizard bid: grand total into #totalPrice, gutters prefilled from value_adds.
  s.el('totalPrice').value = '12000';
  s.el('gutter6InchPrice').value = '2000';
  const quote = { total_price: 12000, per_trade_breakdown: { roofing: 10000, gutters: 2000 } };
  if (s.have.includes('_applyStoredBreakdown')) s.ctx._applyStoredBreakdown(quote);
  s.run('wizardGoTo(2, 0, false)');
  s.run('wizardNext()'); s.run('wizardNext()');   // click through, change nothing
  await flush();
  assert.equal(money(s.el('wizardGrandTotal').textContent), 12000, 'Grand Total');
  assert.equal(s.run('effectiveBidAmount()'), 12000, 'stored total_price');
  assert.deepEqual(JSON.parse(JSON.stringify(s.run('roundedTradePrices()'))), { roofing: 10000, gutters: 2000 });
  assert.equal(money(s.el('feeDollarDisplay').textContent), 600, 'fee shown');
});

await t('F2: populate seeds the wizard prices from per_trade_breakdown', () => {
  assert.ok(/if \(_restoreWizard\) _applyStoredBreakdown\(quote\);/.test(HTML));
});

await t('non-wizard bid is untouched: effectiveBidAmount returns #totalPrice as typed', () => {
  const s = sandbox();
  s.run('wizardMode = false');
  s.el('totalPrice').value = '18000.004';
  assert.equal(s.run('effectiveBidAmount()'), 18000.004);
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
