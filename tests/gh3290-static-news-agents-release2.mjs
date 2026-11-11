/**
 * gh-3290 — /news/agents-get-ahead-of-roof-non-renewals.html body text must equal
 * RELEASE 2 (insurance-agent release) byte-for-byte, and every link must carry the
 * exact partner-release utm string where the approved copy has one.
 *
 * Source of truth: Marketing/drafts/cro85-p15-3290-release2-build-spec.md (RELEASE 2,
 * copied from cro80-roof-season-partner-releases-v4-urls.md). Fixture below is that
 * text verbatim. Two mechanical normalisations only, same as the week-1 page (#3193):
 * the editorial source tags "[S3]".."[S7]" are not published, and {DATE} is filled
 * with the publish date.
 *
 * Run: node tests/gh3290-static-news-agents-release2.mjs
 *      GH3290_MUTATE=1 node ...  (negative control: flips one char of the page text)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'news/agents-get-ahead-of-roof-non-renewals.html';
const PUBLISH_DATE_TEXT = 'November 11, 2026';
const UTM = 'utm_source=partner-release&utm_medium=onsite&utm_campaign=roof-buying-season&utm_content=agent';

const RELEASE2 = `# The Best Agents Are Getting Ahead of Roof Non-Renewals

**INDIANAPOLIS, {DATE}.** No agent wants a client to get a renewal letter with a roof problem attached. [S3] Mediocre agents are good at apologizing when the upset calls come in. Great agents raise the conversation early and provide proactive solutions.

ACV roof schedules, roof-age limits and non-renewals mean more clients are paying for more of their roof out of pocket. A ZestyAI analysis found that ACV roof settlement schedules at the top 10 US homeowners carriers grew from 10 percent of policies in 2015 to 60 percent in 2025. [S4] If your only advice to your clients is for them to get three bids, you are failing to protect their property and their wallet.

The best insurance agents are telling their clients that winter is [Roof Buying Season](https://otterquote.com/news/roof-buying-season.html?${UTM}). When demand for roofs falls in the winter, many contractors are more willing to negotiate better prices and better materials. [S5] So great insurance agents are teaching their clients [how to negotiate a great price on a new roof](https://otterquote.com/guides/hire-roofer-paying-out-of-pocket.html). They are also teaching their clients about the importance of [hail-resistant shingles](https://otterquote.com/guides/class-4-impact-resistant-shingles.html) and [labor warranties backed by the manufacturers](https://otterquote.com/guides/manufacturer-backed-roof-warranties.html), so a hailstorm is less likely to mean another new roof. [S6]

Don't leave your clients scrambling for contractors this spring. Talk to them now and help them get a better deal. [S7]

**About Otter Quotes.** Otter Quotes sends a homeowner's scope of work to contractors and lets them compete for the job online, with no salesperson at the kitchen table.

Contractors Compete. Homeowners Win.`;

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

// RELEASE 2 markdown -> expected paragraph list of plain text (headline separated)
const [headline, ...paras] = RELEASE2.split('\n\n');
const expectedH1 = headline.replace(/^# /, '');
const expectedParas = paras.map(p => p
  .replace(/ ?\[S\d\]/g, '')
  .replace('{DATE}', PUBLISH_DATE_TEXT)
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\*\*/g, ''));
const expectedLinks = [...paras.join('\n\n').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(m => [m[1], m[2]]);

const html = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const bodyHtml = html.match(/<div class="article-body">([\s\S]*?)<\/div>\s*<\/section>/)[1];
let pageParas = [...bodyHtml.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => decode(m[1].replace(/<[^>]+>/g, '')));
if (process.env.GH3290_MUTATE) pageParas[1] = pageParas[1].replace('ACV', 'ACW'); // one-char mutation
const pageH1 = decode(html.match(/<h1>([\s\S]*?)<\/h1>/)[1]);

ok(pageH1 === expectedH1, 'H1 equals RELEASE 2 headline');
ok(pageParas.length === expectedParas.length, `paragraph count ${pageParas.length} === ${expectedParas.length}`);
ok(JSON.stringify(pageParas) === JSON.stringify(expectedParas), 'article body text equals RELEASE 2 byte-for-byte (after HTML strip)');
expectedParas.forEach((p, i) => { if (pageParas[i] !== p) console.log(`  diff at paragraph ${i}:\n    page: ${pageParas[i]}\n    spec: ${p}`); });
ok(!/\[S\d\]/.test(bodyHtml) && !/\{DATE\}/.test(html), 'no [S#] tags or {DATE} placeholder left on page');

// links: text + href (HTML-decoded) must equal RELEASE 2's; the utm link must carry the exact utm string
const pageLinks = [...bodyHtml.matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)].map(m => [decode(m[2]), decode(m[1])]);
ok(JSON.stringify(pageLinks) === JSON.stringify(expectedLinks), `all ${expectedLinks.length} links (text + href) equal RELEASE 2`);
const utmLinks = pageLinks.filter(([, h]) => h.includes('utm_'));
ok(utmLinks.length === 1 && utmLinks[0][1].endsWith('?' + UTM), 'the utm link carries the exact utm string');
ok(/utm_content=agent(?!\w)/.test(utmLinks[0]?.[1] || ''), 'utm_content=agent');

// head/meta consistency
const slugUrl = 'https://otterquote.com/news/agents-get-ahead-of-roof-non-renewals.html';
ok(html.includes(`<link rel="canonical" href="${slugUrl}">`) && html.includes(`<meta property="og:url" content="${slugUrl}">`), 'canonical + og:url = page URL');
ok(html.includes(`<title>${expectedH1} | Otter Quotes</title>`), 'title = headline | Otter Quotes');
const desc = "No agent wants a client to get a renewal letter with a roof problem attached.";
ok(html.split(`"${desc}"`).length - 1 === 3 || html.split(`content="${desc}"`).length - 1 === 2, 'meta description = first sentence of RELEASE 2');
ok(!/realtor/i.test(html), 'no leftover week-1 realtor copy');

const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
ok(sm.includes(`<loc>${slugUrl}</loc>`), 'sitemap lists the page');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
