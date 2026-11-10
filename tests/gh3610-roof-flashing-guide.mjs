// gh-3610: the guide /guides/roof-flashing-replacement-bid.html exists, carries valid FAQPage JSON-LD with its
// 5 Q&As, is in the sitemap and is wired into the guides index. Static, no browser, no secrets.
// Negative control: on origin/main the page is absent (404 today), so every check below fails there.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'roof-flashing-replacement-bid';
const PATH = `guides/${SLUG}.html`;
const URL = `https://otterquote.com/guides/${SLUG}.html`;
const H1 = 'Does Your Roof Replacement Bid Say What Happens to the Flashing?';
const TITLE = 'Roof Flashing in a Replacement Bid | Otter Quotes';

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
