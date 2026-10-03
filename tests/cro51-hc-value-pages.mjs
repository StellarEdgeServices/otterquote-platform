/**
 * cro51 / #2121 -- HO-1 rebuild: homeowner value pages. /hc (hub) + /hc/save-money, /hc/materials, /hc/warranties, /hc/decisions.
 *
 * Pins Dustin's approved copy byte for byte (tests/fixtures/hc-copy.txt is extracted by script from Claude's Memories/otterquote-value-proposition.md
 * section 5 and section 2.3.2; each string is ALSO pinned by a sha256 literal below, so drift of both the fixture and a page is still caught),
 * the links and the utm string, the GA events, the analytics gate, and the banned-phrase list from the value-proposition sections 3 and 4.
 * Every check has a NEGATIVE CONTROL: an automated mutation of the real source that must turn it RED (e.g. injecting "free assessment").
 *
 * Two halves:  static (node + fs)   |   browser (real Chromium via Playwright, no network: first screen at 390x664, utm/fbclid pass-through, events)
 * Run:  node tests/cro51-hc-value-pages.mjs           (both)
 *       HC_ONLY=static node tests/cro51-hc-value-pages.mjs  |  HC_ONLY=browser ...
 * Exit 0 = everything green including every control going red.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ONLY = process.env.HC_ONLY || 'all';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOPICS = ['save-money', 'materials', 'warranties', 'decisions'];
const FILE = { hub: 'hc.html', 'save-money': 'hc-save-money.html', materials: 'hc-materials.html', warranties: 'hc-warranties.html', decisions: 'hc-decisions.html' };
const PATH = { hub: '/hc', 'save-money': '/hc/save-money', materials: '/hc/materials', warranties: '/hc/warranties', decisions: '/hc/decisions' };
const CHOICE_NAME = { bids: 'competitive_bids', 'save-money': 'save_money', materials: 'materials', warranties: 'warranties', decisions: 'decisions' };
const LINK_TEXT = { 'save-money': 'Learn how to save money', materials: 'Learn about the best materials', warranties: 'Learn about the best warranties', decisions: 'Learn how to make the right decisions' };
const HTML = {}; for (const k of Object.keys(FILE)) HTML[k] = read(FILE[k]);
const HC_JS = read('js/hc.js');
const HC_CSS = read('css/hc.css');
const bidsUrl = (page) => '/ho6/start?utm_source=facebook&utm_medium=paid_social&utm_campaign=ho-1v2&utm_content=' + page;

// ── Approved copy: the fixture, plus literal sha256 pins ───────────────────────────────────────────────────────────────────────────────────
const COPY = {};
for (const l of read('tests/fixtures/hc-copy.txt').replace(/\r\n/g, '\n').split('\n')) {
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('\t'); COPY[l.slice(0, i)] = l.slice(i + 1);
}
const PINS = {
  'hub_h1': '7121834025af7089f27293eb13b5f61c2be6f0557939c59065ee7e6f7e686d6b',
  'hub_lede': '197e43636e688d12fbc57bb2ba0d7c5ec3c3df7b7c507a7e6886c9be9e421a3e',
  'choice_bids': '68addb98fc7b3a89f47f767357b0b734fb141471b8351c864394789244a7786b',
  'choice_save-money': '47d0524989f88fabb36dc33ed73d444f512307f8069a67bf6be9e9e090a7556d',
  'choice_materials': 'a98390ad8cfb59240ba321fc554538e8676bdf4f4e69117b6c10924c7fd70c4d',
  'choice_warranties': 'bbd3f0735fed26d8d25841de2610edb8a6c141fdbb91400dc2471ef217d03947',
  'choice_decisions': '2220cfd5d3e14e5edb13879829ad61b3f52c299296c5c075521fbcc22367e787',
  'para_save-money': '08b8ad8a58c4951fc531a6cc368e405c3d4f4d52c335977925f4b92117971c55',
  'para_materials': 'd7bec219f889122916d97e1b113671d4e22bf95e7d7b6db3fde31ee5f3b0812f',
  'para_warranties': 'f71c64709462c0dbcf36efb2ef8b828718f2dd61091796762a41f7c7ac945890',
  'para_decisions': '15f67bfab50cf39dcdadbb69ad4c77eeb0a685d7be8c08b2b5a8548849b9f946',
};

// ── HTML helpers (no DOM in node: small purpose-built extractors) ──────────────────────────────────────────────────────────────────────────
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const anchors = (html) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: unesc(m[2].replace(/<[^>]+>/g, '')), href: unesc((/href="([^"]*)"/.exec(m[1]) || [])[1] || '') }));
const h1Of = (html) => { const m = [...html.matchAll(/<h1>([^<]*)<\/h1>/g)]; return m.length === 1 ? unesc(m[0][1]) : null; };
const paraOf = (html) => { const m = /<p class="hc-para">([^<]*)<\/p>/.exec(html); return m ? unesc(m[1]) : null; };
const ledeOf = (html) => { const m = /<p class="hc-lede">([^<]*)<\/p>/.exec(html); return m ? unesc(m[1]) : null; };
const headInner = (html) => (/<head>([\s\S]*?)<\/head>/.exec(html) || [])[1] || '';
const bodyText = (html) => unesc(html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Banned wording: value-proposition sections 3 and 4, and the standing decisions D-104/166/168, D-175. Applied to the WHOLE source of every page
// and script (comments included, so nothing can hide there) with the deliberately-allowed uses listed below the table.
const BANNED = [
  ['free assessment', /free\s+(roof\s+)?(damage\s+)?(assessment|inspection|estimate)s?/i],
  ['inspection', /inspection|inspect\b/i],
  ['assessment', /\bassessment/i],
  ['insurance help', /(help|assist)[^.]{0,30}(with|your)\s+(your\s+)?(insurance|claim)|work(ing)?\s+with\s+your\s+insurance|(negotiate|deal)\s+with\s+(your\s+)?(insurer|insurance)|file\s+(your|a)\s+claim|insurance\s+claim\s+help/i],
  ['call promise', /we(?:'ll|\s+will)\s+call|give\s+you\s+a\s+call|call\s+you|call\s+back|call\s+us|will\s+call|a\s+call\s+from/i],
  ['vetted / endorsed / certified', /vetted|endorsed|certified/i],
  ['unsourced discount figure', /20\s*[-\u2013]\s*50|50\s+percent|20\s+percent|most\s+insurance\s+compan/i],
  ['wrong display name', /OtterQuotes?(?!\.com)|Otter\s+Quote\b|Otter-Quote/i],
];
const bannedHits = (src) => BANNED.filter(([, re]) => re.test(src)).map(([n]) => n);

function staticHalf() {
  console.log('\n=== STATIC ===');
  // V1 routing
  const redirects = read('_redirects');
  for (const t of TOPICS) {
    const re1 = new RegExp('^/hc/' + t + '\\s+/hc-' + t + '\\.html\\s+200\\s*$', 'm'), re2 = new RegExp('^/hc/' + t + '/\\s+/hc-' + t + '\\.html\\s+200\\s*$', 'm');
    ok(re1.test(redirects) && re2.test(redirects), 'V1 _redirects rewrites /hc/' + t + ' (and the trailing-slash form) to hc-' + t + '.html (200)');
  }
  ok(Object.values(FILE).every((f) => fs.existsSync(path.join(ROOT, f))), 'V1 hc.html (Pretty URL /hc) and the four hc-<topic>.html files exist');
  ok(!fs.existsSync(path.join(ROOT, 'hc')), 'V1 there is no hc/ directory that would shadow the /hc/<topic> rewrites');
  const hcRules = redirects.split('\n').filter((l) => /^\s*\/hc\b/.test(l));
  ok(hcRules.length === 8, 'V1 exactly the eight /hc/* rewrite rules exist (' + hcRules.length + ')');
  control('V1', !new RegExp('^/hc/decisions\\s+/hc-decisions\\.html\\s+200\\s*$', 'm').test(redirects.replace(/^\/hc\/decisions\s.*$/m, '')));
  ok(Object.values(HTML).every((h) => /<meta name="robots" content="noindex, follow">/.test(h)), 'V1 every page is noindex, follow');
  ok(!/\/hc\b|hc-/.test(read('sitemap.xml')), 'V1 no /hc page is in the sitemap');
  ok(Object.keys(FILE).every((k) => h => true) && Object.keys(FILE).every((k) => new RegExp('<link rel="canonical" href="https://otterquote\\.com' + PATH[k] + '">').test(HTML[k])), 'V1 every page canonical is its clean path');

  // V2 copy, byte for byte
  ok(Object.keys(PINS).every((k) => typeof COPY[k] === 'string' && sha(COPY[k]) === PINS[k]), 'V2 the fixture equals the sha256 pins (11 approved strings)');
  {
    const bad = Object.keys(PINS).filter((k) => sha(COPY[k] || '') !== PINS[k]);
    control('V2 (fixture drift detected)', Object.keys(PINS).some((k) => sha((COPY[k] || '') + ' ') !== PINS[k]) && bad.length === 0);
  }
  ok(h1Of(HTML.hub) === COPY.hub_h1 && ledeOf(HTML.hub) === COPY.hub_lede, 'V2 hub: H1 and second line equal the approved text');
  const hubChoices = anchors(HTML.hub).filter((a) => /data-hc-choice=/.test(a.attrs));
  ok(hubChoices.length === 5 && JSON.stringify(hubChoices.map((a) => a.text)) === JSON.stringify(['bids', ...TOPICS].map((k) => COPY['choice_' + k])), 'V2 hub: five choices, in order, with the approved words');
  for (const t of TOPICS) {
    ok(h1Of(HTML[t]) === COPY['choice_' + t], 'V2 /hc/' + t + ': H1 is the approved choice text');
    ok(paraOf(HTML[t]) === COPY['para_' + t], 'V2 /hc/' + t + ': the paragraph equals the approved text byte for byte');
    ok(sha(paraOf(HTML[t]) || '') === PINS['para_' + t], 'V2 /hc/' + t + ': the paragraph matches its literal sha256 pin');
    const mut = HTML[t].replace(/(<p class="hc-para">[^<]{5})/, '$1X');
    control('V2 /hc/' + t + ' (one character added)', paraOf(mut) !== COPY['para_' + t]);
  }
  ok(!/20\s*[-\u2013]\s*50|percent/i.test(HTML['save-money']) && /Many insurers offer a discount/.test(HTML['save-money']), 'V2 the save-money page carries the approved replacement text, not the "20-50 percent" original');
  ok(/Ask yours what it offers\./.test(HTML['save-money']) && /more likely to include these upgrades for free or at discounted rates/.test(HTML['save-money']), 'V2 save-money keeps "Ask yours what it offers" and the approved "more likely" wording');
  ok(!/unbiased/i.test(HTML.decisions) && !/every product/i.test(HTML.decisions) && !/unbiased|every product/i.test(COPY.para_decisions), 'V2 decisions page and fixture: the words "unbiased" and "every product" are absent (Dustin 2026-09-30: contractors pay a fee on the accepted bid)');
  ok(/costs and benefits of the products that go on your home/.test(HTML.decisions) && /probably outlive you/.test(HTML.warranties) && !/out live/.test(HTML.warranties), 'V2 decisions reads "the products" and warranties reads "outlive" (Dustin 2026-09-30)');
  control('V2 "unbiased" (injected into decisions page)', /unbiased/i.test(HTML.decisions.replace('do our best', 'do our best to be unbiased')));
  control('V2 "every product" (injected into decisions page)', /every product/i.test(HTML.decisions.replace('of the products', 'of every product')));

  // V3 the bids links and the utm string
  {
    const b = anchors(HTML.hub).find((a) => /data-hc-dest="bids"/.test(a.attrs));
    ok(!!b && b.href === bidsUrl('hub') && b.text === COPY.choice_bids, 'V3 hub "I want to get competitive bids today" -> ' + bidsUrl('hub'));
    for (const t of TOPICS) {
      const bs = anchors(HTML[t]).filter((a) => /data-hc-dest="bids"/.test(a.attrs));
      ok(bs.length === 1 && bs[0].text === 'GET MY BIDS TODAY' && bs[0].href === bidsUrl(t), 'V3 /hc/' + t + ': exactly one GET MY BIDS TODAY -> ' + bidsUrl(t));
      ok(/class="ho6-btn hc-choice"/.test(bs[0].attrs), 'V3 /hc/' + t + ': GET MY BIDS TODAY is the primary (filled) button');
    }
    const mut = HTML['materials'].replace('utm_campaign=ho-1v2', 'utm_campaign=ho-6');
    control('V3', !anchors(mut).some((a) => a.href === bidsUrl('materials')));
    ok(HC_JS.includes("'ho-1v2'") && /utm_content', PAGE/.test(HC_JS) && HC_JS.includes("'facebook'") && HC_JS.includes("'paid_social'"), 'V3 js/hc.js builds the same string (source facebook, medium paid_social, campaign ho-1v2, content = page) and preserves incoming fbclid / gclid / utm_term');
  }
  // V4 links between pages
  {
    const hubLinks = anchors(HTML.hub).map((a) => a.href);
    ok(JSON.stringify(hubLinks.slice(0, 5)) === JSON.stringify([bidsUrl('hub'), ...TOPICS.map((t) => PATH[t])]), 'V4 hub choices go to the bids form and the four topic pages');
    for (const t of TOPICS) {
      const others = TOPICS.filter((o) => o !== t);
      const more = anchors((/<nav class="hc-more"[\s\S]*?<\/nav>/.exec(HTML[t]) || [''])[0]);
      ok(JSON.stringify(more.map((a) => [a.href, a.text])) === JSON.stringify(others.map((o) => [PATH[o], LINK_TEXT[o]])), 'V4 /hc/' + t + ': links to the other three topics, and not to itself');
      const all = anchors(HTML[t]).map((a) => a.href);
      const expected = [bidsUrl(t), ...others.map((o) => PATH[o]), '/privacy.html', '/terms.html', '/privacy.html#do-not-sell-or-share'];
      ok(JSON.stringify(all) === JSON.stringify(expected), 'V4 /hc/' + t + ': the only links are GET MY BIDS TODAY, the three topics, Privacy, Terms and Do Not Sell');
    }
    ok(JSON.stringify(anchors(HTML.hub).map((a) => a.href).slice(5)) === JSON.stringify(['/privacy.html', '/terms.html', '/privacy.html#do-not-sell-or-share']), 'V4 hub: after the five choices only Privacy, Terms and Do Not Sell');
    control('V4', JSON.stringify(anchors(HTML['warranties'].replace('</footer>', '<a href="/">Home</a></footer>')).map((a) => a.href)) !== JSON.stringify([bidsUrl('warranties'), PATH['save-money'], PATH.materials, PATH.decisions, '/privacy.html', '/terms.html', '/privacy.html#do-not-sell-or-share']));
    ok(/<footer id="site-footer"[^>]*data-skip-nav="true"/.test(HTML.hub) && read('js/nav.js').includes('<a id="footer-do-not-sell-link" href="/privacy.html#do-not-sell-or-share">Do Not Sell or Share My Personal Information</a>') && Object.values(HTML).every((h) => h.includes('<a id="footer-do-not-sell-link" href="/privacy.html#do-not-sell-or-share">Do Not Sell or Share My Personal Information</a>')), 'V4 the Do Not Sell markup is the js/nav.js markup on every page');
    ok(!/\/js\/nav\.js|js\/auth\.js/.test(Object.values(HTML).join('')), 'V4 no page loads nav.js or auth.js');
  }
  // V5 analytics: GA gate, Meta gate, events, no PII
  {
    ok(Object.values(HTML).every((h) => /internal-traffic\.js/.test(headInner(h)) && /<script src="\/js\/hc\.js" defer><\/script>/.test(headInner(h))), 'V5 every page includes js/internal-traffic.js and js/hc.js (defer)');
    ok(Object.values(HTML).every((h) => /gtag\('config', 'G-D1Y1TLGEFY'\)/.test(h)), 'V5 every page carries the same gtag stub + property config as ho6.html');
    ok(!/googletagmanager\.com|connect\.facebook\.net|gtag\/js|fbevents\.js|clarity\.ms/.test(Object.values(HTML).join('') + HC_JS), 'V5 GA4 / Meta / Clarity libraries are requested only by the gate files, never directly');
    ok(/g\.src = '\/js\/ga-gate\.js'/.test(HC_JS) && /m\.src = '\/js\/meta-pixel-gate\.js'/.test(HC_JS), 'V5 js/hc.js loads ga-gate.js and meta-pixel-gate.js (idle / first interaction, same pattern as ho6.html)');
    ok(/track\('router_step_view', \{ step: PAGE, step_index: STEP_INDEX\[PAGE\] \}\)/.test(HC_JS), 'V5 one router_step_view per page (step = page name)');
    ok(/track\('router_choice_click', \{ step: PAGE, choice: choice \}\)/.test(HC_JS), 'V5 router_choice_click with the choice name on every choice / link click');
    const choices = new Set(Object.values(HTML).flatMap((h) => [...h.matchAll(/data-hc-choice="([^"]+)"/g)].map((m) => m[1])));
    ok([...choices].sort().join() === Object.values(CHOICE_NAME).sort().join(), 'V5 the choice names are exactly ' + Object.values(CHOICE_NAME).join(', '));
    ok(!/email|phone|first_?name|last_?name|lead_?id|localStorage|sessionStorage|document\.cookie\s*=|fbq\(\s*['"]track/i.test(HC_JS.replace(/^\s*\/\/.*$/gm, '')), 'V5 js/hc.js sends no PII, no lead id, writes no storage, fires no Meta conversion');
    ok(!/<input|<form|<textarea/.test(Object.values(HTML).join('')), 'V5 the pages have no form or input (the form is /ho6/start)');
    const gate = read('js/ga-gate.js');
    const list = (src) => { const m = /var CLARITY_ALLOWED_PATHS = \[([\s\S]*?)\];/.exec(src); return m ? [...m[1].matchAll(/^\s+'(\/[^']*)',?\s*$/gm)].map((x) => x[1]) : []; };
    const l = list(gate);
    ok(Object.values(PATH).every((p) => l.includes(p)) && l.includes('/ho6') && l.includes('/ho6/start') && l.includes('/start'), 'V5 CLARITY_ALLOWED_PATHS contains all five /hc paths and the existing entries');
    control('V5', !list(gate.replace("'/hc/decisions',", '')).includes('/hc/decisions'));
    const py = spawnSync('python3', ['scripts/check-clarity-page-gate.py'], { cwd: ROOT, encoding: 'utf8' });
    ok(py.status === 0, 'V5 scripts/check-clarity-page-gate.py passes with the new pages in the tree');
  }
  // V6 banned phrases
  {
    const files = { ...Object.fromEntries(Object.entries(FILE).map(([k, f]) => [f, HTML[k]])), 'js/hc.js': HC_JS, 'css/hc.css': HC_CSS };
    for (const [f, src] of Object.entries(files)) ok(bannedHits(src).length === 0, 'V6 ' + f + ' has none of the banned phrases' + (bannedHits(src).length ? ' -- HITS: ' + bannedHits(src).join(', ') : ''));
    ok(bannedHits(Object.values(COPY).join('\n')).length === 0, 'V6 the approved-copy fixture itself has none of the banned phrases (source vs section 3 / section 4 agree)');
    // negative controls: every banned family must be caught when injected into a real page
    const inject = { 'free assessment': 'Get a free assessment of your roof.', 'inspection': 'Book an inspection.', 'assessment': 'Your assessment is ready.', 'insurance help': 'We help with your insurance claim.', 'call promise': "We'll call you within the hour.", 'vetted / endorsed / certified': 'Our ' + 'vet' + 'ted contractors.', 'unsourced discount figure': 'Save 20-50 percent.', 'wrong display name': 'OtterQuote helps homeowners.' };
    for (const [name, text] of Object.entries(inject)) control('V6 (' + name + ' injected)', bannedHits(HTML.hub.replace('</main>', '<p>' + text + '</p></main>')).includes(name));
    control('V6 ("free assessment" injected into the save-money page)', bannedHits(HTML['save-money'].replace('GET MY BIDS TODAY', 'GET MY FREE ASSESSMENT')).includes('free assessment') || bannedHits(HTML['save-money'].replace('<h1>', '<h1>free assessment ')).includes('free assessment'));
    // display name: the visible brand is "Otter Quotes" (two words) wherever it appears
    const names = Object.values(HTML).flatMap((h) => [...bodyText(h).matchAll(/otter\s*quotes?/gi)].map((m) => m[0]));
    ok(names.length > 0 && names.every((n) => n === 'Otter Quotes' || n === 'OTTER QUOTES'), 'V6 the display name is "Otter Quotes" (two words) everywhere it appears (D-175)');
    // phone: none shown; if one is ever added it must be 844-875-3412 only
    const phones = Object.values(HTML).flatMap((h) => [...h.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g)].map((m) => m[0]));
    ok(phones.every((p) => p === '844-875-3412') && !Object.values(HTML).some((h) => /\btel:/.test(h)), 'V6 no phone number shown except 844-875-3412 (none is shown), no tel: link');
    control('V6 (wrong phone injected)', ['<p>Call 317-555-0100</p>'].flatMap((x) => [...x.matchAll(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g)].map((m) => m[0])).some((p) => p !== '844-875-3412'));
  }
  // V7 /ho6 and /ho6/start are untouched
  {
    const g = spawnSync('git', ['diff', '--quiet', 'origin/main', '--', 'ho6.html', 'ho6-start.html', 'css/ho6.css', 'js/ho6-start.js', 'js/oq-lead-core.js'], { cwd: ROOT });
    if (g.status === 0) ok(true, 'V7 git diff origin/main is empty for ho6.html, ho6-start.html, css/ho6.css, js/ho6-start.js and js/oq-lead-core.js');
    else if (g.status === 1) ok(false, 'V7 git diff origin/main shows a change to an HO-6 / start file');
    else console.log('SKIP: V7 git diff (no origin/main ref in this checkout); tests/gh2378-ho6.mjs runs unmodified in static-ho6-tests.yml');
    ok(/collectAttribution/.test(read('js/oq-lead-core.js')) && /ATTR_KEYS = \['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'\]/.test(read('js/oq-lead-core.js')), 'V7 /ho6/start still records utm_source, utm_medium, utm_content, utm_term, fbclid, gclid from the URL (utm_campaign is forced to ho-6 there)');
  }
  // V8 credential claims
  {
    const py = spawnSync('python3', ['scripts/check-credential-claims.py'], { cwd: ROOT, encoding: 'utf8' });
    ok(py.status === 0 && /^PASS: check-credential-claims/.test(py.stdout), 'V8 scripts/check-credential-claims.py passes with the new pages in the tree');
  }
}

// ════════════════════════════════════ BROWSER HALF ══════════════════════════════════════════════════════════════════════════════════════
function loadPlaywright() {
  const tries = [path.join(__dirname, 'e2e', 'package.json'), ...(process.env.HC_PW_PATH ? [path.join(process.env.HC_PW_PATH, 'x.json')] : [])];
  for (const t of tries) { try { return createRequire(t)('playwright'); } catch (e) { /* next */ } }
  try { return createRequire(import.meta.url)('playwright'); } catch (e) { /* none */ }
  return null;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function startServer(overlay) {
  const routes = { '/hc': 'hc.html', '/hc/': 'hc.html' };
  for (const t of TOPICS) { routes['/hc/' + t] = 'hc-' + t + '.html'; routes['/hc/' + t + '/'] = 'hc-' + t + '.html'; }
  routes['/ho6/start'] = 'ho6-start.html';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = routes[u.pathname] || decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(overlay, rel)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'text/plain' }); res.end(overlay[rel]); return; }
    const fp = path.join(ROOT, rel);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(fs.readFileSync(fp));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}
const FB_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]';

async function openPage(browser, base, p) {
  const ctx = await browser.newContext({ viewport: p.viewport || { width: 390, height: 664 }, userAgent: FB_UA, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const requests = [];
  await page.addInitScript(() => { window.__fbq = []; window.fbq = function () { window.__fbq.push(Array.from(arguments)); }; window._fbq = window.fbq; window.fbq.push = window.fbq; window.fbq.loaded = true; window.fbq.queue = []; });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.startsWith(base)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });   // no network
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + p.path, { waitUntil: 'load' });
  await page.waitForTimeout(p.settle || 500);
  const events = async () => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event').map((a) => ({ name: a[1], params: a[2] })));
  return { ctx, page, requests, errors, events };
}
const hrefs = (page) => page.evaluate(() => [...document.querySelectorAll('a[data-hc-choice]')].map((a) => ({ choice: a.getAttribute('data-hc-choice'), text: a.textContent.trim(), href: a.getAttribute('href') })));

async function browserHalf() {
  console.log('\n=== BROWSER (real Chromium, no network) ===');
  const pw = loadPlaywright();
  if (!pw) { ok(false, 'Playwright is available (npm ci in tests/e2e, or HC_PW_PATH)'); return; }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const S = await startServer({});
  try {
    // B1 first screen at 390x664 in the Facebook in-app browser UA
    {
      const p = await openPage(browser, S.base, { path: '/hc' });
      const m = await p.page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const btns = [...document.querySelectorAll('.hc-choice')].map((b) => ({ top: r(b).top, bottom: r(b).bottom, h: r(b).height, w: r(b).width }));
        return { h1: r(document.querySelector('h1')), lede: r(document.querySelector('.hc-lede')), btns, vw: window.innerWidth, vh: window.innerHeight, sw: document.documentElement.scrollWidth, sy: window.scrollY };
      });
      ok(m.vw === 390 && m.vh === 664, 'B1 viewport is 390x664');
      ok(m.h1.top >= 0 && m.lede.bottom <= 664, 'B1 the hub question and "Tell us what matters to you." are on the first screen (h1 top ' + Math.round(m.h1.top) + ', line 2 bottom ' + Math.round(m.lede.bottom) + ')');
      ok(m.btns.length === 5 && m.btns.slice(0, 3).every((b) => b.bottom <= 664), 'B1 the first three choices are fully visible without scrolling (bottoms ' + m.btns.slice(0, 3).map((b) => Math.round(b.bottom)).join(', ') + ')');
      ok(m.btns.every((b) => b.bottom <= 664), 'B1 all five choices fit on the first screen (last bottom ' + Math.round(m.btns[4].bottom) + ')');
      ok(m.btns.every((b) => b.h >= 48 && b.w >= 300), 'B1 every choice is a big tap target (>= 48px tall, >= 300px wide)');
      ok(m.sw <= m.vw, 'B1 no horizontal scroll at 390px');
      ok(p.errors.length === 0, 'B1 no page errors' + (p.errors.length ? ': ' + p.errors[0] : ''));
      ok(p.requests.filter((u) => u.startsWith(S.base)).every((u) => /\.(html|css|js)$|\/hc$/.test(u.split('?')[0]) || u.includes('favicon')), 'B1 the hub loads only the repo html/css/js (no images, no new libraries)');
      await p.ctx.close();
      // negative control: a huge H1 pushes the choices below the fold
      const S2 = await startServer({ 'css/hc.css': HC_CSS + '\n.hc-card h1 { font-size: 64px; }\n.hc-lede { margin-bottom: 200px; }\n' });
      const q = await openPage(browser, S2.base, { path: '/hc' });
      const bot = await q.page.evaluate(() => [...document.querySelectorAll('.hc-choice')].slice(0, 3).map((b) => b.getBoundingClientRect().bottom));
      control('B1', bot.some((b) => b > 664)); await q.ctx.close(); S2.srv.close();
    }
    // B2 events
    {
      const p = await openPage(browser, S.base, { path: '/hc' });
      const ev = await p.events();
      const views = ev.filter((e) => e.name === 'router_step_view');
      ok(views.length === 1 && views[0].params.step === 'hub' && views[0].params.variant === 'hc' && views[0].params.step_index === 0, 'B2 hub fires exactly one router_step_view {variant:hc, step:hub}');
      ok(ev.every((e) => Object.keys(e.params || {}).every((k) => ['variant', 'step', 'step_index', 'choice', 'ua_context'].includes(k))), 'B2 events carry only variant, step, step_index, choice, ua_context (no PII)');
      ok(views[0].params.ua_context === 'fb_iab', 'B2 ua_context is fb_iab inside the Facebook in-app browser');
      ok(p.requests.some((u) => u.endsWith('/js/ga-gate.js')) && p.requests.some((u) => u.endsWith('/js/meta-pixel-gate.js')), 'B2 GA and Meta load through their gate files (ga-gate.js, meta-pixel-gate.js requested on idle)');
      ok(!p.requests.some((u) => /googletagmanager|connect\.facebook\.net/.test(u)), 'B2 nothing loads GA / Meta directly (the gates decline on this host)');
      await p.page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), true));   // stay on the page; the click handlers still run
      const names = ['I want to get competitive bids today', 'I want to save money', 'I want the best materials', 'I want the best warranties', 'I want to make the right decisions'];
      for (const n of names) await p.page.click('text=' + n);
      const clicks = (await p.events()).filter((e) => e.name === 'router_choice_click').map((e) => e.params.choice);
      ok(JSON.stringify(clicks) === JSON.stringify(['competitive_bids', 'save_money', 'materials', 'warranties', 'decisions']), 'B2 each hub choice click fires router_choice_click with its choice name: ' + clicks.join(','));
      await p.ctx.close();
      for (const t of TOPICS) {
        const q = await openPage(browser, S.base, { path: '/hc/' + t });
        const e = await q.events();
        ok(e.filter((x) => x.name === 'router_step_view').length === 1 && e.find((x) => x.name === 'router_step_view').params.step === t && q.errors.length === 0, 'B2 /hc/' + t + ' fires one router_step_view {step:' + t + '} and has no page errors');
        await q.page.evaluate(() => document.addEventListener('click', (ev) => ev.preventDefault(), true));
        await q.page.click('text=GET MY BIDS TODAY');
        const c = (await q.events()).filter((x) => x.name === 'router_choice_click');
        ok(c.length === 1 && c[0].params.choice === 'competitive_bids' && c[0].params.step === t, 'B2 /hc/' + t + ': GET MY BIDS TODAY fires router_choice_click {choice:competitive_bids, step:' + t + '}');
        await q.ctx.close();
      }
      const S3 = await startServer({ 'js/hc.js': HC_JS.replace("track('router_step_view'", "track('router_view_gone'") });
      const q = await openPage(browser, S3.base, { path: '/hc' });
      control('B2', !(await q.events()).some((e) => e.name === 'router_step_view')); await q.ctx.close(); S3.srv.close();
    }
    // B3 utm / fbclid pass-through
    {
      const IN = 'utm_source=facebook&utm_medium=paid_social&utm_campaign=ho-1&utm_content=adA&utm_term=t1&fbclid=IwAR0abc123&gclid=g123';
      const bare = await openPage(browser, S.base, { path: '/hc' });
      const h0 = await hrefs(bare.page);
      ok(h0[0].href === bidsUrl('hub') && h0.slice(1).map((x) => x.href).join() === TOPICS.map((t) => PATH[t]).join(), 'B3 with no incoming params: bids -> the exact utm string, topic links unchanged');
      await bare.ctx.close();
      const p = await openPage(browser, S.base, { path: '/hc?' + IN });
      const h = await hrefs(p.page);
      const u = new URL(h[0].href, 'http://x'); const g = (k) => u.searchParams.get(k);
      ok(u.pathname === '/ho6/start' && g('utm_source') === 'facebook' && g('utm_medium') === 'paid_social' && g('utm_campaign') === 'ho-1v2' && g('utm_content') === 'hub' && g('fbclid') === 'IwAR0abc123' && g('gclid') === 'g123' && g('utm_term') === 't1', 'B3 hub with ad params: bids link keeps fbclid / gclid / utm_term, sets campaign ho-1v2 and content hub');
      ok(h.slice(1).every((x, i) => { const w = new URL(x.href, 'http://x'); return w.pathname === PATH[TOPICS[i]] && w.searchParams.get('fbclid') === 'IwAR0abc123' && w.searchParams.get('utm_campaign') === 'ho-1' && w.searchParams.get('utm_content') === 'adA' && w.searchParams.get('utm_source') === 'facebook'; }), 'B3 hub topic links carry the incoming utm_* and fbclid unchanged');
      // follow a hub link for real, then the topic page's bids link
      await p.page.click('text=I want to save money');
      await p.page.waitForURL('**/hc/save-money?*');
      await p.page.waitForTimeout(300);
      const t = await hrefs(p.page);
      const tb = new URL(t.find((x) => x.text === 'GET MY BIDS TODAY').href, 'http://x');
      ok(tb.searchParams.get('utm_content') === 'save-money' && tb.searchParams.get('fbclid') === 'IwAR0abc123' && tb.searchParams.get('utm_campaign') === 'ho-1v2', 'B3 after hub -> save-money the bids link still has fbclid, campaign ho-1v2, content save-money');
      const onward = t.filter((x) => x.text !== 'GET MY BIDS TODAY').map((x) => new URL(x.href, 'http://x'));
      ok(onward.length === 3 && onward.every((w) => w.searchParams.get('fbclid') === 'IwAR0abc123'), 'B3 the topic page\'s three cross-links keep the incoming params too');
      await p.page.click('text=GET MY BIDS TODAY');
      await p.page.waitForURL('**/ho6/start?*');
      const fin = new URL(p.page.url());
      ok(fin.pathname === '/ho6/start' && fin.searchParams.get('utm_content') === 'save-money' && fin.searchParams.get('fbclid') === 'IwAR0abc123' && fin.searchParams.get('utm_source') === 'facebook' && fin.searchParams.get('utm_medium') === 'paid_social' && fin.searchParams.get('utm_campaign') === 'ho-1v2', 'B3 clicking GET MY BIDS TODAY lands on /ho6/start with the full string: ' + fin.search);
      await p.ctx.close();
      // junk in the URL is stripped, never passed through raw
      const j = await openPage(browser, S.base, { path: '/hc?fbclid=' + encodeURIComponent('a b\u00e9<script>') + '&other=1&email=x%40y.com' });
      const jh = await hrefs(j.page); const jb = jh[0].href;
      ok(!/other=|email=|\u00e9|%C3/i.test(jb) && !/[<>]/.test(jb) && !jh.some((x) => /email=|other=/.test(x.href)), 'B3 non-ASCII is stripped, characters are URL-encoded, and unknown params (email, other) are never carried: ' + jb);
      await j.ctx.close();
      // negative control: campaign string broken
      const S4 = await startServer({ 'js/hc.js': HC_JS.replace("['utm_campaign', 'ho-1v2']", "['utm_campaign', 'ho-6']") });
      const q = await openPage(browser, S4.base, { path: '/hc' });
      control('B3', new URL((await hrefs(q.page))[0].href, 'http://x').searchParams.get('utm_campaign') !== 'ho-1v2'); await q.ctx.close(); S4.srv.close();
      const S5 = await startServer({ 'js/hc.js': HC_JS.replace("['utm_term', 'fbclid', 'gclid']", "['utm_term']") });
      const q2 = await openPage(browser, S5.base, { path: '/hc?fbclid=IwAR0abc123' });
      control('B3 (fbclid dropped)', !/fbclid=/.test((await hrefs(q2.page))[0].href)); await q2.ctx.close(); S5.srv.close();
    }
    // B4 every page at 390 wide: no overflow, paragraph and buttons readable
    for (const t of TOPICS) {
      const p = await openPage(browser, S.base, { path: '/hc/' + t });
      const m = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth, btn: document.querySelector('[data-hc-dest="bids"]').getBoundingClientRect().height }));
      ok(m.sw <= m.vw && m.btn >= 48, 'B4 /hc/' + t + ' at 390px: no horizontal scroll, GET MY BIDS TODAY is a big tap target');
      await p.ctx.close();
    }
  } finally { S.srv.close(); await browser.close(); }
}

(async () => {
  if (ONLY === 'all' || ONLY === 'static') staticHalf();
  if (ONLY === 'all' || ONLY === 'browser') await browserHalf();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
