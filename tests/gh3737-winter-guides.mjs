// gh-3737: three winter guides (windows, siding, gutters) exist, carry valid FAQPage JSON-LD with 5 Q&As each, are in the sitemap and wired into
// the guides index, llms.txt, _redirects and the edge redirect map. Static, no browser, no secrets.
// Negative control: on origin/main none of the three pages exists (404 at filing, curl 2026-11-15), so every check below fails there.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = [
  { slug: 'window-replacement-in-winter-what-your-bid-should-say', h1: 'Can You Replace Windows in Winter? What Your Bid Should Say', title: 'Replacing Windows in Winter: What to Ask | Otter Quotes' },
  { slug: 'siding-installation-in-cold-weather-what-to-ask', h1: 'Can Vinyl Siding Be Installed in Winter? What Your Bid Should Say', title: 'Siding in Cold Weather: What to Ask | Otter Quotes' },
  { slug: 'gutter-installation-in-winter-what-to-ask', h1: 'Can Gutters Be Installed in Winter? What Your Bid Should Say', title: null },
];
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : detail ? ' -- ' + detail : ''}`);
  if (!ok) failed++;
}
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

for (const g of GUIDES) {
  const { slug, h1 } = g;
  const PATH = `guides/${slug}.html`;
  const URL = `https://otterquote.com/guides/${slug}.html`;
  const page = read(PATH);
  console.log(`\n== ${slug}`);
  check('guide page exists', page.length > 0, PATH + ' is missing');
  const h1s = [...page.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  check('exactly one H1 and it is the approved H1', h1s.length === 1 && h1s[0] === h1, JSON.stringify(h1s));
  if (g.title) check('title tag is the approved title', page.includes(`<title>${g.title}</title>`));
  check('canonical points at the guide URL', page.includes(`<link rel="canonical" href="${URL}">`));
  check('byline is the company only (D-414)', page.includes('Otter Quotes &middot; Updated November 2026') && !/Dustin/.test(page));
  if (slug.startsWith('window-')) {
    check('window page closing box is the live window box (D-375): plain how-it-works link, no start button, no Nebraska (D-169)', page.includes('<p>You compare the bids online, next to reviews and licensing information, and you do not need a salesperson to visit your home. Contractors pay Otter Quotes a fee on the accepted bid. We do not sell upgrades, and we are not a contractor.</p>') && page.includes('<a href="/how-it-works.html">How Otter Quotes works</a>') && !page.includes('Get my bids today') && !page.includes('<a href="/start.html"') && !/Nebraska/.test(page));
  } else {
    check('closing box is the neutral form (no trades, no price)', page.includes('We are not a contractor, we do not sell upgrades and we do not work with your insurance company.') && !/\$22\.63/.test(page));
  }
  check('no em or en dashes, no exclamation marks in the page text', !/[\u2013\u2014]/.test(page.replace(/<[^>]+>/g, '')) && !/!/.test(page.replace(/<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')));
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/g)];
  let faq = null;
  for (const b of blocks) { try { const j = JSON.parse(b[1]); if (j['@type'] === 'FAQPage') faq = j; } catch (e) { /* invalid block */ } }
  check('FAQPage JSON-LD present and parses', faq !== null);
  const qa = faq ? faq.mainEntity || [] : [];
  check('FAQPage has exactly 5 Questions with answers', qa.length === 5 && qa.every((q) => q['@type'] === 'Question' && q.name && q.acceptedAnswer && q.acceptedAnswer.text));
  const visible = [...page.matchAll(/<div class="faq-item">\s*<h3>([\s\S]*?)<\/h3>\s*<div class="faq-answer">\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [m[1].trim(), m[2].trim()]);
  check('visible FAQ matches the JSON-LD Q&As (5, same text)', visible.length === 5 && qa.length === 5 && visible.every(([q, a], i) => unesc(q) === qa[i].name && unesc(a) === qa[i].acceptedAnswer.text));
  check('sitemap.xml lists the guide URL', read('sitemap.xml').includes(`<loc>${URL}</loc>`));
  check('guides index links the guide', read('guides/index.html').includes(`href="/guides/${slug}.html"`));
  check('llms.txt lists the guide', read('llms.txt').includes(URL));
  check('_redirects has the extensionless 301', read('_redirects').includes(`/guides/${slug} /guides/${slug}.html 301`));
  check('edge redirect map has the guide', read('netlify/edge-functions/blog-guides-redirect.ts').includes(`'/guides/${slug}':`));
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
