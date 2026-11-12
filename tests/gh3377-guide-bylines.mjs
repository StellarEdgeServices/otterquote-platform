/**
 * gh-3377 -- Dustin's byline on the 32 guides he cleared (comment 6743612757, D-414), in the format 5217adbd put on the first ten.
 * PASS = the byline string is on each of the 32 guides, the Article JSON-LD author is Dustin (Person) where the page has an Article,
 * and no html file outside the 32 + the ten earlier guides carries the byline string.
 * Run: node tests/gh3377-guide-bylines.mjs     Exit 0 = all PASS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BY = `By <a href="/about.html" style="color:inherit;text-decoration:underline">Dustin Stohler</a> and <a href="/about.html#sloane" style="color:inherit;text-decoration:underline">Sloane</a>, Otter Quotes' AI marketing executive`;
const PERSON = '"author": {"@type": "Person", "name": "Dustin Stohler", "url": "https://otterquote.com/about.html", "sameAs": ["https://www.linkedin.com/in/dustinstohler/"]}';
const NEW32 = [
  'after-adjuster-estimate-next-steps',
  'algae-resistant-shingle-warranties',
  'class-4-impact-resistant-shingles',
  'contractor-workmanship-warranty',
  'gutter-bid-comparison',
  'gutter-replacement-cost-factors',
  'hail-damaged-windows-gutters-bids',
  'hire-roofer-paying-out-of-pocket',
  'how-long-does-roof-replacement-take',
  'how-to-choose-contractor',
  'how-to-read-contractor-estimate',
  'limited-lifetime-shingle-warranty',
  'manufacturer-backed-roof-warranties',
  'multiple-bids-roof-insurance-claim',
  'online-roof-bids-no-salesperson',
  'prove-date-of-loss-hail',
  'roof-bid-comparison-tool',
  'roof-bid-comparison-worksheet',
  'roof-bid-much-lower-than-the-others',
  'roof-change-orders-hidden-damage',
  'roof-permit-in-your-bid',
  'roof-replacement-cost-breakdown',
  'roof-replacement-in-cold-weather',
  'roof-tarp-while-you-wait-for-repairs',
  'roof-wind-ratings-explained',
  'roofers-backed-up-after-storm',
  'second-storm-open-claim',
  'show-contractor-insurance-estimate',
  'siding-bid-comparison',
  'siding-replacement-cost-factors',
  'window-replacement-bid-comparison',
  'window-replacement-cost-factors',
];
const TEN = ['competitive-roof-bids-vs-single-referral','contractor-bid-higher-than-insurance-estimate','contractor-offers-to-waive-deductible','hail-damage-found-months-later','hail-damaged-siding-matching-bids','how-to-file-property-damage-claim','how-to-negotiate-with-insurer','otter-quotes-vs-thumbtack-angi','roof-insurance-check-mortgage-contractor-payment','roofing-contract-checklist-before-you-sign'];
// roof-bid-comparison-tool is an interactive tool page with no Article JSON-LD, so it gets the visible byline only.
const NO_ARTICLE_LD = new Set(['roof-bid-comparison-tool']);
let fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); if (!c) fail++; };
const read = (p) => fs.readFileSync(p, 'utf8');
ok(NEW32.length === 32 && new Set(NEW32).size === 32, 'list holds 32 distinct guides');
for (const s of NEW32) {
  const h = read(path.join(ROOT, 'guides', s + '.html'));
  ok(h.includes(BY), s + ': visible byline present');
  if (!NO_ARTICLE_LD.has(s)) ok(h.includes(PERSON) && !/"author":\s*\{[^}]*"@type":\s*"Organization"/.test(h), s + ': Article author is Dustin (Person)');
}
const allowed = new Set([...NEW32, ...TEN].map((s) => path.join('guides', s + '.html')));
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'tests'].includes(e.name)) continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p, o) : p.endsWith('.html') && o.push(p); } return o; };
const carriers = walk(ROOT).map((p) => path.relative(ROOT, p)).filter((r) => read(path.join(ROOT, r)).includes(BY));
const extra = carriers.filter((r) => !allowed.has(r));
ok(extra.length === 0, 'no page outside the 32 + earlier ten carries the byline' + (extra.length ? ': ' + extra.join(', ') : ''));
ok(carriers.length === 42, 'exactly 42 pages carry the byline (got ' + carriers.length + ')');
console.log(fail ? 'RESULT: FAIL (' + fail + ')' : 'RESULT: ALL PASS');
process.exit(fail ? 1 : 0);
