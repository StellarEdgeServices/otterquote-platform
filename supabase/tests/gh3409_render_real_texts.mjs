// gh-3409: render the REAL fee-disclosure texts from the two bid forms' own source files, as psql \set lines.
// Usage: node gh3409_render_real_texts.mjs <repo-root>   (prints \set lines to stdout)
// Nothing is retyped: the HTML form's generateExactFeeText() and the React copy.ts buildFeeDisclosureText() (with the splitFeeDisclosureText() it calls since gh-3480) are cut out of their files and run.
// One exception, named: text_react_legacy_* is the PRE-gh-3480 React wording (the net/disbursement sentence). No form emits it any more, so it cannot be rendered from a source file;
// it is built here from a template that fee_acceptance_text_check still recognises, and is used only for FORGED inputs (K3, K4, K14) and the tolerance control (K15).
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] || '.';
const html = fs.readFileSync(path.join(root, 'contractor-bid-form.html'), 'utf8');
const ts = fs.readFileSync(path.join(root, 'react-app/app/contractor/bid/[claimId]/copy.ts'), 'utf8');
// startRe must match from the start of the declaration through the '{' that opens the function body (so a '{' in a return type is never mistaken for it).
const cut = (src, startRe, what) => {
  const m = startRe.exec(src); if (!m) { console.error('NOT FOUND: ' + what); process.exit(3); }
  let i = m.index + m[0].length - 1, depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, j + 1);
};
const htmlFn = cut(html, /function generateExactFeeText\(\) \{/, 'generateExactFeeText');
const stripTs = (fn) => fn.replace(/^export /, '').replace(/: number/g, '').replace(/\): string \{/, ') {').replace(/\): \{ lead: string; rest: string \} \{/, ') {');
const tsFn = stripTs(cut(ts, /export function splitFeeDisclosureText\([^)]*\): \{ lead: string; rest: string \} \{/, 'splitFeeDisclosureText'))
  + '\n' + stripTs(cut(ts, /export function buildFeeDisclosureText\([^)]*\): string \{/, 'buildFeeDisclosureText'));
const renderHtml = new Function('feePct', 'feeAmount', 'const window = { _feePct: feePct, _feeAmount: feeAmount }; const _platformFeePct = 5;' + htmlFn + '; return generateExactFeeText();');
const renderReact = new Function(tsFn + '; return buildFeeDisclosureText;')();
const out = (name, v) => { if (v.includes("'")) { console.error('apostrophe in ' + name); process.exit(4); } console.log(`\\set ${name} '${v}'`); };
// The bids the proof seeds: total, pct. The browser computes fee = total * pct / 100 as a float.
const cases = { q1: [18500, 5], q2: [15000, 5], q6: [12345.5, 5], q6b: [12345.5, 5], q7: [15000, 5], q8: [15000, 5], q9: [15000, 5], q15: [15000, 5], q16: [15000, 5] };
for (const [k, [total, pct]] of Object.entries(cases)) {
  const fee = total * pct / 100;
  out('text_html_' + k, renderHtml(pct, fee));
  out('text_react_' + k, renderReact(pct, fee, total));
}
// Wording-drift control: the HTML text with one word changed, as a Legal edit of the form would produce.
// Pre-gh-3480 React wording (see the header): rate and fee printed twice, plus the net the contractor would receive.
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const legacyReact = (pct, fee, total) => `By submitting this bid, you agree to pay Otter Quotes a platform fee of ${pct.toFixed(2)}% (${money(fee)}) upon contract execution. This fee is deducted from your bid amount before disbursement. You will receive ${money(total - fee)} upon completion. I understand and agree to the platform fee of ${pct.toFixed(2)}% (${money(fee)})`;
out('text_react_legacy_q2', legacyReact(5, 750, 15000));
out('text_html_drift', renderHtml(5, 750).replace('you agree to pay', 'you promise to pay'));
console.log(`\\echo rendered ${Object.keys(cases).length * 2 + 2} texts from the two form source files`);
