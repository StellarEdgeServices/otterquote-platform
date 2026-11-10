// gh-3592: the Otter Quotes vs Thumbtack and vs Angi comparison guides must exist, carry valid
// FAQPage JSON-LD, appear in sitemap.xml and be linked from the guides index. Dustin's rulings
// (#3418, #3388 6743627648): no trademark notice, no guarantee mention, windows not offered.
// Run from repo root: node tests/gh3592-vs-guides.mjs
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const GUIDES = ['thumbtack', 'angi'];
let n = 0; const fails = [];
function check(name, fn) { try { fn(); console.log('ok ' + (++n) + ' - ' + name); } catch (e) { fails.push(name); console.log('NOT OK - ' + name + ': ' + e.message); } }
const read = (p) => readFileSync(p, 'utf8');

for (const g of GUIDES) {
  const path = `guides/otter-quotes-vs-${g}.html`;
  const url = `https://otterquote.com/guides/otter-quotes-vs-${g}.html`;
  const name = g === 'angi' ? 'Angi' : 'Thumbtack';
  check(`${g}: page exists`, () => assert.ok(existsSync(path), path + ' missing'));
  if (!existsSync(path)) continue;
  const html = read(path);
  check(`${g}: canonical, one h1, start.html CTA`, () => {
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    assert.ok(html.includes('<a href="/start.html" class="btn btn-primary btn-lg">Get my bids today</a>'));
  });
  check(`${g}: valid FAQPage JSON-LD matching the visible FAQ`, () => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = blocks.filter((b) => b['@type'] === 'FAQPage');
    assert.equal(faq.length, 1, 'expected exactly one FAQPage block');
    const me = faq[0].mainEntity;
    assert.equal(me.length, 4);
    const visible = (html.match(/<div class="faq-item">/g) || []).length;
    assert.equal(visible, me.length, 'visible FAQ count differs from JSON-LD');
    for (const q of me) {
      assert.equal(q['@type'], 'Question');
      assert.ok(q.name && q.acceptedAnswer && q.acceptedAnswer['@type'] === 'Answer' && q.acceptedAnswer.text);
      assert.ok(html.includes(q.name.replace(/&/g, '&amp;')) || html.includes(q.name), 'question not on page');
    }
    assert.ok(me[0].name.includes(name));
  });
  check(`${g}: rulings honoured (no guarantee wording, no trademark notice, no windows)`, () => {
    const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    assert.ok(!/guarantee|warranty-?\s*of\s*satisfaction|100.hour/i.test(body), 'guarantee wording present');
    assert.ok(!/&reg;|&trade;|\u00AE|\u2122|registered trademark/i.test(html), 'trademark notice present');
    assert.ok(!/window/i.test(body), 'window claim present');
  });
  check(`${g}: D-388 retired claim absent (every contractor uses/starts), narrowed measurement line present`, () => {
    assert.ok(!/every contractor (uses|starts)/i.test(html), 'retired "every contractor" measurement claim present (D-388)');
    assert.ok(html.includes('If you order the aerial roof report, you get professional measurements that contractors use to bid.'));
  });
  check(`${g}: in sitemap.xml and linked from guides index`, () => {
    assert.ok(read('sitemap.xml').includes(`<loc>${url}</loc>`), 'not in sitemap');
    assert.ok(read('guides/index.html').includes(`href="/guides/otter-quotes-vs-${g}.html"`), 'not linked from guides index');
  });
}
if (existsSync('guides/otter-quotes-vs-thumbtack.html') && existsSync('guides/otter-quotes-vs-angi.html')) {
  check('the two guides cross-link', () => {
    assert.ok(read('guides/otter-quotes-vs-thumbtack.html').includes('/guides/otter-quotes-vs-angi.html'));
    assert.ok(read('guides/otter-quotes-vs-angi.html').includes('/guides/otter-quotes-vs-thumbtack.html'));
  });
}
console.log(fails.length ? `\nFAILED ${fails.length}: ${fails.join('; ')}` : `\nall ${n} checks passed`);
process.exit(fails.length ? 1 : 0);
