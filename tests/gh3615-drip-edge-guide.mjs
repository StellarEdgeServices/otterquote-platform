// gh-3615: the guide /guides/drip-edge-roof-replacement-bid.html exists, carries valid FAQPage JSON-LD with its
// 5 Q&As, is in the sitemap and is wired into the guides index. Static, no browser, no secrets.
// Negative control: on origin/main the page is absent (404 today), so every check below fails there.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'drip-edge-roof-replacement-bid';
const PATH = `guides/${SLUG}.html`;
const URL = `https://otterquote.com/guides/${SLUG}.html`;
const H1 = 'What Should Your Roof Replacement Bid Say About Drip Edge?';
const TITLE = 'Drip Edge in Your Roof Replacement Bid | Otter Quotes';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : detail ? ' -- ' + detail : ''}`);
  if (!ok) failed++;
}
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

const page = read(PATH);
check('guide page exists', page.length > 0, PATH + ' is missing');
const h1s = [...page.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
check('exactly one H1 and it is the approved H1', h1s.length === 1 && h1s[0] === H1, JSON.stringify(h1s));
check('title tag is the approved title', page.includes(`<title>${TITLE}</title>`));
check('canonical points at the guide URL', page.includes(`<link rel="canonical" href="${URL}">`));
check('byline is the company only (D-414)', page.includes('Otter Quotes &middot; Updated November 2026') && !/Dustin/.test(page));

// FAQPage JSON-LD: parses, exactly 5 Q&As, each answer matches the visible FAQ answer text.
const blocks = [...page.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/g)];
let faq = null;
for (const b of blocks) {
  try { const j = JSON.parse(b[1]); if (j['@type'] === 'FAQPage') faq = j; } catch (e) { /* invalid JSON-LD block */ }
}
check('fits paragraph says measurements that contractors use to bid (D-388)', page.includes('for measurements that contractors use to bid'));
check('"every contractor" is absent from the page and its JSON-LD (D-388)', !/every contractor/i.test(page));
check('v2 read must-fix 1 applied: Silver Pledge sentence reworded', page.includes('For its Silver Pledge and Golden Pledge limited warranties, GAF also says the eaves need a non-corroding metal drip edge.')
  && !page.includes('it requires non-corroding metal drip edges at the eaves where a Silver Pledge or Golden Pledge limited warranty is sought'));
check('v2 read must-fix 2 applied: code layer-order sentence reworded', page.includes('At the eaves, underlayment laps over the drip edge; at the rakes, the drip edge sits on top of the underlayment.')
  && !page.includes('Underlayment goes over the drip edge along the eaves and under the drip edge along the rake edges.'));
check('no em or en dashes, no exclamation marks in the page text', !/[–—]/.test(page.replace(/<[^>]+>/g, '')) && !/!/.test(page.replace(/<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')));
check('FAQPage JSON-LD present and parses', faq !== null);
const qa = faq ? faq.mainEntity || [] : [];
check('FAQPage has exactly 5 Questions with answers',
  qa.length === 5 && qa.every((q) => q['@type'] === 'Question' && q.name && q.acceptedAnswer && q.acceptedAnswer.text));
const visible = [...page.matchAll(/<div class="faq-item">\s*<h3>([\s\S]*?)<\/h3>\s*<div class="faq-answer">\s*<p>([\s\S]*?)<\/p>/g)]
  .map((m) => [m[1].trim(), m[2].trim()]);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
check('visible FAQ matches the JSON-LD Q&As (5, same text)',
  visible.length === 5 && qa.length === 5 && visible.every(([q, a], i) => unesc(q) === qa[i].name && unesc(a) === qa[i].acceptedAnswer.text));

check('sitemap.xml lists the guide URL', read('sitemap.xml').includes(`<loc>${URL}</loc>`));
check('guides index links the guide', read('guides/index.html').includes(`href="/guides/${SLUG}.html"`));
check('llms.txt lists the guide', read('llms.txt').includes(URL));
check('_redirects has the extensionless 301', read('_redirects').includes(`/guides/${SLUG} /guides/${SLUG}.html 301`));
check('edge redirect map has the guide', read('netlify/edge-functions/blog-guides-redirect.ts').includes(`'/guides/${SLUG}':`));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
