/**
 * gh-1411 -- contractor opportunities page: a contractor who has ALREADY bought the detailed measurement report for a
 * claim sees "Purchased" and is not offered the $25/$55 buy button again. The signal is per-CONTRACTOR (that contractor's own
 * roof_upgrade_detailed hover_orders row), never the claim's shape: a `full` claim still shows the buy panel to a contractor
 * who has not bought (D-317 cl. 4, REVIEW 5869709815 / LEGAL-READ 5869712252).
 *
 * Runs the REAL getUpgradePurchaseHtml() source extracted from the page in a vm context.
 * Run: node tests/gh1411-contractor-purchased-state.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.env.GH1411_PAGE || path.join(root, 'contractor-opportunities.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

function extractFn(src, name) {
  const m = new RegExp('function ' + name + '\\(').exec(src);
  if (!m) return null;
  let d = 0;
  for (let k = src.indexOf('{', m.index); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(m.index, k + 1); }
  }
  return null;
}
const fnSrc = extractFn(html, 'getUpgradePurchaseHtml');
ok(!!fnSrc, 'page defines getUpgradePurchaseHtml');
const ctx = vm.createContext({
  escHtml: (s) => String(s),
  UPGRADE_SQ_TIER_BOUNDARY: 50, UPGRADE_PRICE_UNDER_CENTS: 2500, UPGRADE_PRICE_AT_OR_OVER_CENTS: 5500,
});
vm.runInContext(`
  function upgradeTierPriceCents(sq){ return sq >= UPGRADE_SQ_TIER_BOUNDARY ? UPGRADE_PRICE_AT_OR_OVER_CENTS : UPGRADE_PRICE_UNDER_CENTS; }
  function fmtCents(c){ return '$' + (c/100).toFixed(2); }
  ${fnSrc}`, ctx);
const render = (o) => ctx.getUpgradePurchaseHtml(o);

// buyer: purchased state, no buy button, no price, no pay controls
for (const [label, sq, shape] of [['basic, 63 SQ', 63, 'basic'], ['full, 63 SQ', 63, 'full'], ['basic, 30 SQ', 30, 'basic'], ['no squares on file', null, null]]) {
  const h = render({ id: 'c1', hoverSquares: sq, measurementShape: shape, upgradePurchased: true });
  ok(/Purchased/.test(h), `buyer (${label}): shows Purchased`);
  ok(!/upgrade-buy-btn|upgrade-pay-btn|data-oq-action="upgrade-open"|Buy Detailed/.test(h), `buyer (${label}): no buy button or pay controls`);
  ok(!/\$\d/.test(h), `buyer (${label}): no price shown`);
}
// non-buyer: unchanged (D-317 cl. 4 -- later contractors still pay, including on a full-shape claim)
for (const [label, o, price] of [
  ['basic 63 SQ', { id: 'c2', hoverSquares: 63, measurementShape: 'basic', upgradePurchased: false }, '$55.00'],
  ['full 63 SQ', { id: 'c3', hoverSquares: 63, measurementShape: 'full', upgradePurchased: false }, '$55.00'],
  ['full 30 SQ, flag unset', { id: 'c4', hoverSquares: 30, measurementShape: 'full' }, '$25.00'],
]) {
  const h = render(o);
  ok(h.includes('upgrade-buy-btn') && h.includes('Buy Detailed Measurement Report') && h.includes(price), `non-buyer (${label}): still offered the buy button at ${price}`);
  ok(!/Purchased/.test(h), `non-buyer (${label}): no Purchased state`);
}
ok(render({ id: 'c5', hoverSquares: null, measurementShape: 'basic' }) === '', 'non-buyer with no squares: still no button (unchanged)');
// the page still does not special-case the claim shape
ok(!/measurementShape|measurement_shape/.test((fnSrc || '').replace(/\/\/.*$/gm, '')), 'getUpgradePurchaseHtml does not branch on the claim shape (REVIEW/LEGAL-READ ruling kept)');
// the load: per-contractor query on this contractor's own roof_upgrade_detailed rows, fail-open
ok(/\.from\('hover_orders'\)[\s\S]{0,200}\.eq\('product_code', 'roof_upgrade_detailed'\)[\s\S]{0,120}\.eq\('requested_by_contractor_id', currentContractor\.id\)/.test(html), 'load reads this contractor\'s own roof_upgrade_detailed hover_orders rows');
ok(/o\.upgradePurchased = boughtSet\.has\(o\.id\)/.test(html), 'load sets upgradePurchased per opportunity');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
