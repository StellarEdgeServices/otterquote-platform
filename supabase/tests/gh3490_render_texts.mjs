// gh-3490: render the REAL fee-disclosure texts the gh3490 proof needs, from the two bid forms' own source files, as psql \set lines.
// Usage: node gh3490_render_texts.mjs <repo-root>
// Nothing is retyped: contractor-bid-form.html generateExactFeeText() and react-app copy.ts splitFeeDisclosureText()/buildFeeDisclosureText() are cut out and run.
// (gh3409_render_real_texts.mjs predates gh-3480, which moved the React form onto the #547 item 1A wording via splitFeeDisclosureText; it is left to its own PR.)
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] || '.';
const html = fs.readFileSync(path.join(root, 'contractor-bid-form.html'), 'utf8');
// drop the TypeScript return-type annotations first, so the brace cut below starts at the function body
const ts = fs.readFileSync(path.join(root, 'react-app/app/contractor/bid/[claimId]/copy.ts'), 'utf8')
  .replace(/\):\s*\{\s*lead:\s*string;\s*rest:\s*string;?\s*\}\s*\{/g, ') {').replace(/\):\s*string\s*\{/g, ') {');
const cut = (src, startRe, what) => {
  const m = startRe.exec(src); if (!m) { console.error('NOT FOUND: ' + what); process.exit(3); }
  let i = src.indexOf('{', m.index + m[0].length - 1), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, j + 1);
};
const untype = (s) => s.replace(/^export /, '').replace(/:\s*number/g, '');
const htmlFn = cut(html, /function generateExactFeeText\(\) \{/, 'generateExactFeeText');
const split = untype(cut(ts, /export function splitFeeDisclosureText\(/, 'splitFeeDisclosureText'));
const build = untype(cut(ts, /export function buildFeeDisclosureText\(/, 'buildFeeDisclosureText'));
const renderHtml = new Function('feePct', 'feeAmount', 'const window = { _feePct: feePct, _feeAmount: feeAmount }; const _platformFeePct = 5;' + htmlFn + '; return generateExactFeeText();');
const renderReact = new Function(split + '\n' + build + '; return buildFeeDisclosureText;')();
const out = (name, v) => { if (v.includes("'")) { console.error('apostrophe in ' + name); process.exit(4); } console.log(`\\set ${name} '${v}'`); };
// bid total -> the browser's float fee at 5%
const totals = { '750': 15000, '800': 16000, '850': 17000, '75001': 15000.20, '75002': 15000.40, '1': 20 };
for (const [k, total] of Object.entries(totals)) {
  const fee = total * 5 / 100;
  out('html_' + k, renderHtml(5, fee));
  out('react_' + k, renderReact(5, fee));
}
console.log(`\\echo rendered ${Object.keys(totals).length * 2} texts from contractor-bid-form.html and react-app copy.ts`);
