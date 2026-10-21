// gh-1340 / #1772 6015862872: top-page tiles show NON-TEST totals; the Otter CRM card links to ?line=otter-crm.
// Run: node tests/gh1340-top-page-nontest.mjs   (exits non-zero on failure)
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../admin-dashboard.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const src = scripts.sort((a, b) => b.length - a.length)[0];
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' present');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
function render(payload) {
  const ctx = { out: '', state: { data: payload }, document: { getElementById: () => ctx.el } };
  ctx.el = { set innerHTML(v) { ctx.out = v; } };
  vm.createContext(ctx);
  vm.runInContext(['esc', 'tileHtml', 'fmtUsd', 'revenueTileHtml', 'renderTopPage'].map(grab).join('\n') + '\nrenderTopPage();', ctx);
  return ctx.out;
}
const tv = (n) => ({ kind: n === 0 ? 'measured_zero' : 'measured', value: n });
const payload = { lines: [
  { key: 'otterquotes', label: 'Otter Quotes', operational: true,
    stats: { homeowners_total: tv(108), homeowners_non_test: tv(42), claims_total: tv(50), claims_non_test: tv(20),
      contractors_total: tv(15), contractors_non_test: tv(2), referral_partners_total: tv(76), referral_partners_non_test: tv(30),
      measurement_orders: tv(3) }, revenue_mtd: { kind: 'not_run', queries: 0 } },
  { key: 'otter-crm', label: 'Otter CRM', operational: false, status_note: 'n', issues_url: 'https://example.invalid/issues' },
  { key: 'oqom', label: 'OQOM', operational: false, status_note: 'n', issues_url: 'https://example.invalid/oqom' },
] };
const out = render(payload);
assert.ok(out.includes('Homeowners (non-test)') && out.includes('>42<'), 'homeowners tile shows the non-test figure 42');
assert.ok(!out.includes('>108<'), 'the with-test total 108 is not on the top page');   // negative control
assert.ok(out.includes('Contractors (non-test)') && out.includes('>2<'));
assert.ok(out.includes('href="?line=otter-crm"'), 'Otter CRM card links to its line page');
assert.ok(out.includes('href="https://example.invalid/oqom"'), 'other not-operational cards still link to their issues');
assert.ok(!out.includes('https://example.invalid/issues'), 'Otter CRM no longer links to the issue list');
console.log('gh1340-top-page-nontest: PASS');
