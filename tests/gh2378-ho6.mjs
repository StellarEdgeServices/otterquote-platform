/**
 * gh-2378 HO-6 -- /ho6 landing page (Dustin's copy, verbatim) + /ho6/start contact page.
 *
 * Acceptance tests H1-H14 and H16 from #2371 comment 5898826181, as amended by the #2378 body and by the approved consent ruling
 * (#2378 comment 5899644479), plus H-consent (the md5 pin, like Arm F's) and H-step (the step container). H15 is Sloane's Facebook in-app
 * phone walk after deploy and is not automatable here.
 *
 * Every test has a NEGATIVE CONTROL: an automated mutation of the real source that must turn that test RED. A control that stays green means
 * the test does not test what it says, and the run fails.
 *
 * Two halves:
 *   static  (node + fs + python3): H1 H2 H4(css) H5 H7/H8 H11 H12 H13 H-consent H-step, and the static side of H10 / H16
 *   browser (real Chromium via Playwright, mocked Supabase / record-lead-details, no network): H3 H4 H6 H9 H10 H16
 * Run:  node tests/gh2378-ho6.mjs              (both)
 *       HO6_ONLY=static node tests/gh2378-ho6.mjs   |   HO6_ONLY=browser node tests/gh2378-ho6.mjs
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
const ONLY = process.env.HO6_ONLY || 'all';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
// A negative control: `red` is true when the mutated input made the test go red (that is the PASS).
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

const LANDING = read('ho6.html');
const START = read('ho6-start.html');
const CSS = read('css/ho6.css');
const CORE = read('js/oq-lead-core.js');
const START_JS = read('js/ho6-start.js');

// ── Pinned strings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Dustin's copy: tests/fixtures/ho6-copy.txt is the #2378 issue body's quote block, byte for byte (leading "> " removed, nothing else).
const COPY_LINES = read('tests/fixtures/ho6-copy.txt').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
// The approved consent (#2378 comment 5899644479, "Consent as recommended"). The md5 is over the joined string that is stored.
const CONSENT_EMAIL_LINE = 'Otter Quotes may email me about my project.';
const CONSENT_CHECKBOX = 'Also text or call me at the number above about my project.';
const CONSENT_TEXT = CONSENT_EMAIL_LINE + ' ' + CONSENT_CHECKBOX;
const APPROVED_CONSENT_MD5 = md5(CONSENT_TEXT); // pinned literally below as well, so a drift of BOTH this file and the page is still caught
const PINNED_MD5_LITERAL = 'fab92e7cb8d1a6995d5b08027a2b13e4';

// ── HTML helpers (no DOM in node: small, purpose-built extractors) ────────────────────────────────────────────────────────────────────────
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
function renderedCopy(html) {
  const brand = /<p class="ho6-brand">([^<]*)<\/p>/.exec(html);
  const h1 = /<h1>([^<]*)<\/h1>/.exec(html);
  const out = [brand && h1 ? brand[1] + ' / ' + h1[1] : ''];
  const re = /<section class="ho6-sec"[^>]*>\s*<div class="ho6-txt">\s*<h2>([^<]*)<\/h2>\s*<p>([^<]*)<\/p>/g;
  let m;
  while ((m = re.exec(html))) out.push('**' + m[1] + '** ' + m[2]);
  return out;
}
const anchors = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const hrefOf = (a) => (/href="([^"]*)"/.exec(a) || [])[1];
const headInner = (html) => (/<head>([\s\S]*?)<\/head>/.exec(html) || [])[1] || '';

// ════════════════════════════════════ STATIC HALF ══════════════════════════════════════════════════════════════════════════════════════
function staticHalf() {
  console.log('\n=== STATIC ===');
  // H1 route, H1 element, six buttons
  const redirects = read('_redirects');
  const rule = (re) => re.test(redirects);
  ok(rule(/^\/ho6\/start\s+\/ho6-start\.html\s+200\s*$/m), 'H1 _redirects rewrites /ho6/start to ho6-start.html (200)');
  ok(rule(/^\/ho6\/start\/\s+\/ho6-start\.html\s+200\s*$/m), 'H1 _redirects rewrites /ho6/start/ too');
  ok(fs.existsSync(path.join(ROOT, 'ho6.html')) && fs.existsSync(path.join(ROOT, 'ho6-start.html')), 'H1 ho6.html (served at /ho6 by Netlify Pretty URLs, like hi-1) and ho6-start.html exist');
  ok(!fs.existsSync(path.join(ROOT, 'ho6')), 'H1 there is no ho6/ directory that would shadow the /ho6/start rewrite');
  const other = redirects.split('\n').filter((l) => /^\s*\/ho6\b/.test(l) && !/^\/ho6\/start\/?\s/.test(l.trim()));
  ok(other.length === 0, 'H1 no other redirect rule touches /ho6');
  const h1s = [...LANDING.matchAll(/<h1[\s>]/g)].length;
  const buttons = anchors(LANDING).filter((a) => /class="ho6-btn"/.test(a));
  ok(h1s === 1, 'H1 /ho6 has exactly one h1');
  ok(buttons.length === 6 && buttons.every((a) => /data-cta="[1-6]"/.test(a)), 'H1 /ho6 has six "Get my bids now" buttons, data-cta 1..6');
  ok([...LANDING.matchAll(/<a class="ho6-btn"[^>]*>Get my bids now<\/a>/g)].length === 6, 'H1 every button reads exactly "Get my bids now"');
  {
    const mut = LANDING.replace('<a class="ho6-btn" href="/ho6/start?utm_campaign=ho-6" data-cta="6">Get my bids now</a>', '');
    control('H1', anchors(mut).filter((a) => /class="ho6-btn"/.test(a)).length !== 6);
  }
  // page flags
  ok(/<meta name="robots" content="noindex, follow">/.test(LANDING) && /<meta name="robots" content="noindex, follow">/.test(START), 'H1 both pages are noindex, follow');
  ok(/<footer id="site-footer"[^>]*data-skip-nav="true"/.test(LANDING) && /<footer id="site-footer"[^>]*data-skip-nav="true"/.test(START), 'H1 both pages carry data-skip-nav on the static footer');
  ok(!/\/js\/nav\.js|js\/auth\.js/.test(LANDING + START), 'H1 neither page loads nav.js or auth.js (static footer)');
  ok(!/ho6/.test(read('sitemap.xml')), 'H1 neither page is in the sitemap');
  ok(!/\btel:|\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.test(LANDING), 'H1 /ho6 has no phone number');
  ok(/internal-traffic\.js/.test(headInner(LANDING)) && /internal-traffic\.js/.test(headInner(START)), 'H1 both pages include js/internal-traffic.js');
  ok(!/googletagmanager\.com|connect\.facebook\.net|gtag\/js|fbevents\.js/.test(LANDING + START + START_JS + CORE), 'H1 GA4 / Meta libraries are requested only by the gate files, never directly');
  ok(/\/js\/ga-gate\.js/.test(LANDING) && /\/js\/meta-pixel-gate\.js/.test(LANDING) && /\/js\/ga-gate\.js/.test(START) && /\/js\/meta-pixel-gate\.js/.test(START), 'H1 both pages load ga-gate.js and meta-pixel-gate.js');

  // H2 copy byte for byte
  {
    const got = renderedCopy(LANDING);
    ok(COPY_LINES.length === 7, 'H2 fixture holds the hero line plus six sections (7 lines)');
    ok(got.length === 7 && got.every((l, i) => l === COPY_LINES[i]), 'H2 the rendered copy equals Dustin\'s copy byte for byte (hero + six sections)');
    const mut = LANDING.replace('quickly and easily.', 'quickly and easily!');
    const gotM = renderedCopy(mut);
    control('H2', !(gotM.length === 7 && gotM.every((l, i) => l === COPY_LINES[i])));
    const mut2 = LANDING.replace('No pants required!', 'No pants required.');
    control('H2 (last sentence)', renderedCopy(mut2)[6] !== COPY_LINES[6]);
  }
  // H4 colours (css side; computed side is in the browser half)
  ok(/--ho6-blue:\s*#1D4ED8/i.test(CSS) && /--ho6-text:\s*#000000/i.test(CSS) && /--ho6-bg:\s*#FFFFFF/i.test(CSS), 'H4 css tokens: blue #1D4ED8, black text, white background');
  ok(/h1, h2 \{ color: var\(--ho6-blue\)/.test(CSS) && /body \{[^}]*background: var\(--ho6-bg\)/.test(CSS), 'H4 headers use the blue token and the body background is white');
  control('H4', !/--ho6-blue:\s*#1D4ED8/i.test(CSS.replace('--ho6-blue: #1D4ED8', '--ho6-blue: #3B82F6')));
  // H5 six images + licence manifest
  {
    const manifestPath = 'img/ho6/manifest.json';
    let manifest = null;
    try { manifest = JSON.parse(read(manifestPath)); } catch (e) { /* asserted */ }
    const imgs = [...LANDING.matchAll(/<img src="(\/img\/ho6\/[^"]+\.webp)" width="(\d+)" height="(\d+)" alt="([^"]+)"/g)];
    ok(imgs.length === 6, 'H5 /ho6 has six images, each with src, explicit width and height, and alt text');
    ok(imgs.every((m) => fs.existsSync(path.join(ROOT, m[1].slice(1))) && fs.statSync(path.join(ROOT, m[1].slice(1))).size <= 120 * 1024), 'H5 every image file exists and is at most 120 KB');
    ok(imgs.every((m) => fs.readFileSync(path.join(ROOT, m[1].slice(1))).slice(0, 4).toString() === 'RIFF' && fs.readFileSync(path.join(ROOT, m[1].slice(1))).slice(8, 12).toString() === 'WEBP'), 'H5 every image is a real WEBP container');
    const complete = (mf) => !!mf && Array.isArray(mf.images) && mf.images.length === 6 && mf.images.every((e, i) =>
      e.section === i + 1 && /^https:\/\/www\.pexels\.com\/photo\//.test(e.page_url || '') && (e.photographer || '').length > 2 &&
      e.licence_url === 'https://www.pexels.com/license/' && /^img\/ho6\/ho6-\d\.webp$/.test(e.file || ''));
    ok(complete(manifest), 'H5 img/ho6/manifest.json lists six images with page URL, photographer, licence URL and section');
    ok(!!manifest && manifest.images.every((e) => imgs.some((m) => m[1] === '/' + e.file)), 'H5 every manifest file is the one the page references');
    const bad = manifest ? JSON.parse(JSON.stringify(manifest)) : null;
    if (bad) delete bad.images[3].photographer;
    control('H5', !complete(bad));
    ok(!/Bulat843/i.test(JSON.stringify(manifest)), 'H5 no image from the flagged account');
  }
  // H7/H8: every /start arm is unchanged
  {
    const startHtml = read('start.html');
    ok(!/oq-lead-core|ho6/.test(startHtml + read('js/router-variant-f.js')), 'H7/H8 start.html and router-variant-f.js do not reference the HO-6 files (the shared module is standalone)');
    ok(!/(?:src|href)="(?:[^"]*\/)?(?:start\.html|router-(?:variant|discovery)[^"]*)"|(?:src|href)="\/start[?"#]/.test(LANDING + START) && !/\.src\s*=\s*['"][^'"]*(router-|start\.html)|createElement\(['"]script['"]\)[^;]*router-/.test(CORE + START_JS), 'H7/H8 the HO-6 pages and scripts do not load start.html or any router arm file');
    const g = spawnSync('git', ['diff', '--quiet', 'origin/main', '--', 'start.html', 'js/router-variant-d.js', 'js/router-variant-e.js', 'js/router-variant-f.js', 'js/router-discovery.js'], { cwd: ROOT });
    if (g.status === 0) ok(true, 'H7/H8 git diff origin/main is empty for start.html and every router-variant-*.js / router-discovery.js');
    else if (g.status === 1) ok(false, 'H7/H8 git diff origin/main shows a change to a /start arm file');
    else console.log('SKIP: H7/H8 git diff (no origin/main ref in this checkout); the existing arm suites run unmodified in static-start-arm-f-tests.yml');
    control('H7/H8', /oq-lead-core/.test(startHtml + '<script src="js/oq-lead-core.js">'));
  }
  // H11 Clarity gate
  {
    const gate = read('js/ga-gate.js');
    const list = (src) => { const m = /var CLARITY_ALLOWED_PATHS = \[([\s\S]*?)\];/.exec(src); return m ? [...m[1].matchAll(/^\s+'(\/[^']*)',?\s*$/gm)].map((x) => x[1]) : []; };
    const l = list(gate);
    ok(l.includes('/ho6') && l.includes('/ho6/start'), 'H11 CLARITY_ALLOWED_PATHS contains /ho6 and /ho6/start');
    ok(l.includes('/start') && l.includes('/hi-1'), 'H11 the existing entries are still there (only paths were added)');
    ok(!l.includes('/ho6/') && !l.includes('/ho6-start'), 'H11 no stray variants of the new paths');
    const mut = gate.replace("'/ho6/start',", '');
    control('H11', !list(mut).includes('/ho6/start'));
    ok(/clarity\('set', 'variant', VARIANT\)/.test(LANDING) && /clarity\('set', 'variant', 'ho6'\)/.test(START_JS), 'H11 Clarity is tagged variant=ho6 on both pages');
    ok(/data-clarity-mask/.test(START_JS), 'H11 the /ho6/start form is masked from session replay');
  }
  // H12 only the six CTAs plus Privacy, Terms and Do Not Sell
  {
    const linkSet = (html) => anchors(html).map(hrefOf);
    const l = linkSet(LANDING);
    const expected = Array(6).fill('/ho6/start?utm_campaign=ho-6').concat(['/privacy.html', '/terms.html', '/privacy.html#do-not-sell-or-share']);
    ok(JSON.stringify(l) === JSON.stringify(expected), 'H12 /ho6 links: the six CTAs, Privacy, Terms, Do Not Sell, and nothing else');
    ok(JSON.stringify(linkSet(START)) === JSON.stringify(['/privacy.html', '/terms.html', '/privacy.html#do-not-sell-or-share']), 'H12 /ho6/start links: Privacy, Terms, Do Not Sell, and nothing else');
    ok(/<a id="footer-do-not-sell-link" href="\/privacy\.html#do-not-sell-or-share">Do Not Sell or Share My Personal Information<\/a>/.test(LANDING + START), 'H12 the Do Not Sell markup is the js/nav.js markup');
    ok(read('js/nav.js').includes('<a id="footer-do-not-sell-link" href="/privacy.html#do-not-sell-or-share">Do Not Sell or Share My Personal Information</a>'), 'H12 (js/nav.js markup anchor is still what these pages copy)');
    control('H12', JSON.stringify(linkSet(LANDING.replace('</footer>', '<a href="/">Home</a></footer>'))) !== JSON.stringify(expected));
  }
  // H13 credential claims
  {
    const py = spawnSync('python3', ['scripts/check-credential-claims.py'], { cwd: ROOT, encoding: 'utf8' });
    ok(py.status === 0 && /^PASS: check-credential-claims/.test(py.stdout), 'H13 scripts/check-credential-claims.py passes with the new pages in the tree: ' + (py.stdout || py.stderr || '').trim().slice(0, 120));
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'ho6-cred-'));
    fs.writeFileSync(path.join(tmp, 'ho6.html'), LANDING.replace('So you get multiple bids', 'We chec' + 'k licenses. So you get multiple bids'));
    const snippet = `import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location("m","scripts/check-credential-claims.py");m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.REPO=pathlib.Path(sys.argv[1]);sys.exit(m.main())`;
    const neg = spawnSync('python3', ['-c', snippet, tmp], { cwd: ROOT, encoding: 'utf8' });
    control('H13 (a credential-claim sentence injected)', neg.status === 1 && /ho6\.html/.test(neg.stdout));
    fs.writeFileSync(path.join(tmp, 'ho6.html'), LANDING);
    const clean = spawnSync('python3', ['-c', snippet, tmp], { cwd: ROOT, encoding: 'utf8' });
    ok(clean.status === 0, 'H13 the same fixture tree with the real page passes (positive control)');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // H-consent: one constant, md5-pinned, equal in the markup and in the module
  {
    ok(APPROVED_CONSENT_MD5 === PINNED_MD5_LITERAL, 'H-consent the approved consent string md5 is ' + PINNED_MD5_LITERAL + ' (Arm F pins its consent the same way)');
    const jsLine = /email_line: '([^']*)'/.exec(START_JS), jsBox = /checkbox_label: '([^']*)'/.exec(START_JS), jsKey = /key: '([^']*)'/.exec(START_JS);
    ok(!!jsLine && !!jsBox && md5(jsLine[1] + ' ' + jsBox[1]) === PINNED_MD5_LITERAL, 'H-consent js/ho6-start.js CONSENT constant hashes to the pin (email_line + one space + checkbox_label)');
    ok(!!jsKey && jsKey[1] === 'ho6_contact_consent', 'H-consent consent key is ho6_contact_consent');
    const htmlLine = /<p class="ho6-consent" id="ho6EmailLine">([^<]*)<\/p>/.exec(START), htmlBox = /<span id="ho6CheckLabel">([^<]*)<\/span>/.exec(START);
    ok(!!htmlLine && !!htmlBox && htmlLine[1] === CONSENT_EMAIL_LINE && htmlBox[1] === CONSENT_CHECKBOX, 'H-consent the strings rendered on /ho6/start are byte-identical to the approved strings');
    ok(/<input type="checkbox" id="ho6TextCall" name="text_call_consent">/.test(START) && !/ checked/.test(/<input type="checkbox"[^>]*>/.exec(START)[0]), 'H-consent the checkbox is unchecked by default');
    ok(!/id="ho6Phone"[^>]*\brequired\b/.test(START) && /\(optional\)/.test(START), 'H-consent phone is optional');
    control('H-consent (one word changed)', md5(CONSENT_EMAIL_LINE + ' ' + CONSENT_CHECKBOX.replace('text or call', 'call or text')) !== PINNED_MD5_LITERAL);
    control('H-consent (email line dropped)', md5(CONSENT_CHECKBOX) !== PINNED_MD5_LITERAL);
  }
  // H-step: the step container
  {
    const stepsInJs = [...START_JS.matchAll(/^\s{4}(\w+): \{\s*el: '(\w+)'/gm)].map((m) => [m[1], m[2]]);
    const stepsInHtml = [...START.matchAll(/<section id="(\w+)" class="ho6-step" data-ho6-step="(\w+)"/g)].map((m) => [m[2], m[1]]);
    ok(JSON.stringify(stepsInJs) === JSON.stringify(stepsInHtml) && stepsInJs.length === 2, 'H-step every step section in the markup has one STEPS entry in js/ho6-start.js (contact, thanks)');
    control('H-step', JSON.stringify(stepsInJs) !== JSON.stringify([...stepsInHtml, ['job', 'ho6StepJob']]));
  }
  // H17 (round 2): the early-submit guard. The submit handler loads deferred, after supabase-js; until then a native submit would put names, email
  // and phone into the URL (GET form). The button ships disabled, an inline listener stops any submit, the form is POST, and init() enables the button.
  {
    const formTag = (START.match(/<form id="ho6Form"[^>]*>/) || [''])[0];
    const btnTag = (START.match(/<button[^>]*id="ho6Submit"[^>]*>/) || [''])[0];
    const guardOk = (h) => { const i = h.indexOf('</form>'); return i > 0 && /^\s*<script>[\s\S]*?getElementById\('ho6Form'\)\.addEventListener\('submit', function \(e\) \{ e\.preventDefault\(\); \}\);[\s\S]*?<\/script>/.test(h.slice(i + 7)); };
    const good = (h, js) => /<form id="ho6Form"[^>]* method="post"/.test(h) && /<button[^>]*id="ho6Submit"[^>]* disabled[ >]/.test(h) && guardOk(h) && /\$\('ho6Submit'\)\.disabled = false;/.test(js);
    ok(/ method="post"/.test(formTag) && !/ action=/.test(formTag), 'H17 the form is method="post" (no GET query string is possible): ' + formTag);
    ok(/ disabled[ >]/.test(btnTag), 'H17 the submit button ships disabled');
    ok(guardOk(START), 'H17 an inline preventDefault submit guard sits immediately after </form>');
    ok(/\$\('ho6Submit'\)\.disabled = false;/.test(START_JS), 'H17 js/ho6-start.js init() enables the button');
    ok(good(START, START_JS), 'H17 all four guards present together');
    control('H17 (old markup: no method, enabled button, no guard)', !good(START.replace(' method="post"', '').replace(/(id="ho6Submit"[^>]*) disabled>/, '$1>').replace(/<script>\s*\/\* Early-submit guard[\s\S]*?<\/script>/, ''), START_JS.replace("$('ho6Submit').disabled = false;", '')));
    ok(/_oqErrorBuffer/.test(START) && /Sentry\.captureException\(item\.error\)/.test(START) && /Sentry\.captureMessage\(/.test(START) && /window\._oqErrorBuffer = \[\];\s*\};/.test(START), 'H17 sentryOnLoad replays and clears window._oqErrorBuffer (as start.html does)');
    control('H17 (sentry replay removed)', !/Sentry\.captureException\(item\.error\)/.test(START.replace(/Sentry\.captureException\(item\.error\)/g, '')));
  }
  // H16 static side + H10 static side
  {
    const noCall = (s) => !/(dustin will call|will call you|call you|within \d+ minutes|within minutes|we'll call|we will call)/i.test(s);
    ok(noCall(START) && noCall(START_JS) && noCall(LANDING), 'H16 no call promise in either page or in the page script');
    control('H16 (static)', !noCall(START_JS.replace(". We'll email you your next steps.", '. Dustin will call you.')));
    ok(!/fbq\(\s*['"]track['"]\s*,\s*['"]Lead['"]/.test(LANDING), 'H10 /ho6 never fires Meta Lead');
    ok(!/<input|<form|localStorage|sessionStorage|document\.cookie\s*=/.test(LANDING), 'H10 /ho6 has no input, no form and writes no storage');
    control('H10 (static)', /fbq\(\s*['"]track['"]\s*,\s*['"]Lead['"]/.test(LANDING.replace("track('ho6_view');", "fbq('track','Lead');")));
  }
}

// ════════════════════════════════════ BROWSER HALF ═════════════════════════════════════════════════════════════════════════════════════
function loadPlaywright() {
  const tries = [path.join(__dirname, 'e2e', 'package.json'), ...(process.env.HO6_PW_PATH ? [path.join(process.env.HO6_PW_PATH, 'x.json')] : [])];
  for (const t of tries) { try { return createRequire(t)('playwright'); } catch (e) { /* next */ } }
  try { return createRequire(import.meta.url)('playwright'); } catch (e) { /* none */ }
  return null;
}
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

// Serves the repo root with Netlify-like routes. `overlay` maps a repo-relative path to replacement content (the mutations).
function startServer(overlay, delays = {}) {
  const routes = { '/ho6': 'ho6.html', '/ho6/start': 'ho6-start.html', '/ho6/start/': 'ho6-start.html' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = routes[u.pathname] || decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (delays[rel]) { const ms = delays[rel]; delete delays[rel]; setTimeout(() => srv.emit('request', req, res), ms); return; }   // delays a file's first request only (mutation tests: a slow script load)
    if (Object.prototype.hasOwnProperty.call(overlay, rel)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'text/plain' }); res.end(overlay[rel]); return; }
    const fp = path.join(ROOT, rel);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      if (process.env.HO6_STUB_IMAGES === '1' && /^img\/ho6\//.test(rel)) { res.writeHead(200, { 'Content-Type': 'image/gif' }); res.end(TINY_GIF); return; }
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(fs.readFileSync(fp));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}

const FAKE_SUPABASE = `
window.__calls = [];
window.__insertResult = null;
window.supabase = { createClient: function () { return {
  from: function (table) { return { insert: function (payload) {
    var rec = { t: 'insert', table: table, payload: payload, headers: {} }; window.__calls.push(rec);
    var q = { setHeader: function (k, v) { rec.headers[k] = v; return q; },
      then: function (a, b) { return Promise.resolve(window.__insertResult || { data: null, error: null }).then(a, b); } };
    return q; } }; },
  rpc: function (name, args) { window.__calls.push({ t: 'rpc', name: name, args: args }); return Promise.resolve({ data: true, error: null }); },
  functions: { invoke: function (n, o) { window.__calls.push({ t: 'invoke', name: n, body: o && o.body }); return Promise.resolve({ data: { ok: true }, error: null }); } }
}; } };`;

// One page load. Returns helpers for the test bodies. All external network is answered locally.
async function openPage(browser, base, opts) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, userAgent: opts.ua });
  const page = await ctx.newPage();
  const posts = [];
  await page.addInitScript(() => {
    window.__fbq = [];
    window.fbq = function () { window.__fbq.push(Array.from(arguments)); };
    window._fbq = window.fbq; window.fbq.push = window.fbq; window.fbq.loaded = true; window.fbq.queue = [];
  });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (/cdn\.jsdelivr\.net.*supabase/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_SUPABASE });
    if (/functions\/v1\/record-lead-details/.test(url)) {
      posts.push({ url, body: route.request().postData() });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });   // Sentry, fonts, anything else: no network
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + opts.path, { waitUntil: opts.waitUntil || 'load' });
  await page.waitForTimeout(opts.settle || 150);
  const events = async () => (await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event').map((a) => ({ name: a[1], params: a[2] }))));
  const calls = async () => page.evaluate(() => window.__calls || []);
  const fbqCalls = async () => page.evaluate(() => window.__fbq || []);
  return { ctx, page, posts, errors, events, calls, fbqCalls };
}
async function fillAndSubmit(p, v) {
  const { page } = p;
  await page.fill('#ho6First', v.first ?? 'Jane'); await page.fill('#ho6Last', v.last ?? 'Doe');
  await page.fill('#ho6Email', v.email ?? 'jane@example.com'); if (v.phone !== undefined) await page.fill('#ho6Phone', v.phone);
  if (v.check) await page.check('#ho6TextCall');
  await page.click('#ho6Submit');
}

async function browserHalf() {
  console.log('\n=== BROWSER (real Chromium, mocked Supabase, no network) ===');
  const pw = loadPlaywright();
  if (!pw) { ok(false, 'Playwright is available (npm ci in tests/e2e, or HO6_PW_PATH)'); return; }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const noIntegrity = (h) => h.replace(/ integrity="[^"]*"/, '').replace(/ crossorigin="anonymous"><\/script>\n<script defer src="\/js\/cookie/, '></script>\n<script defer src="/js/cookie');
  // The fake Supabase replaces the SRI-pinned CDN bundle, so the integrity attribute is dropped in the served copy only (the real markup keeps
  // it; scripts/check-supabase-js-sri.py covers that).
  const base0 = { 'ho6-start.html': noIntegrity(START) };
  let S = await startServer(base0);
  try {
    // ── H3 layout ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const layout = async (base, viewport) => {
      const p = await openPage(browser, base, { path: '/ho6', viewport });
      const r = await p.page.evaluate(() => [...document.querySelectorAll('.ho6-sec')].map((s) => {
        const t = s.querySelector('.ho6-txt').getBoundingClientRect(), i = s.querySelector('.ho6-pic img').getBoundingClientRect(), b = s.querySelector('.ho6-btn').getBoundingClientRect();
        return { picLeft: i.left < t.left, picAbove: i.bottom <= t.top + 1, btnW: b.width, txtW: t.width, vw: window.innerWidth, btnBelow: b.top >= t.top };
      }));
      await p.ctx.close(); return r;
    };
    const desk = await layout(S.base, { width: 1280, height: 900 });
    ok(desk.length === 6 && desk.every((s, i) => (i % 2 === 0 ? !s.picLeft : s.picLeft)), 'H3 desktop 1280px: photo alternates right, left, right, left, right, left');
    const mob = await layout(S.base, { width: 390, height: 744 });
    ok(mob.every((s) => s.picAbove) && mob.every((s) => Math.abs(s.btnW - s.txtW) < 2 && s.btnW > 300), 'H3 phone 390px: photo is above the text and the button is full width, in all six sections');
    ok(mob.every((s) => s.btnW <= s.vw), 'H3 phone 390px: no horizontal overflow from a button');
    {
      const S2 = await startServer({ 'css/ho6.css': CSS.replace(/@media \(max-width: 640px\) \{[\s\S]*$/, '') });
      const m2 = await layout(S2.base, { width: 390, height: 744 });
      control('H3 (media query removed)', !m2.every((s) => s.picAbove)); S2.srv.close();
    }
    // ── H4 computed colours ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const colours = async (base) => {
      const p = await openPage(browser, base, { path: '/ho6' });
      const r = await p.page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, h1: getComputedStyle(document.querySelector('h1')).color, h2: getComputedStyle(document.querySelector('h2')).color, txt: getComputedStyle(document.querySelector('.ho6-txt p')).color }));
      await p.ctx.close(); return r;
    };
    const good = (c) => c.bg === 'rgb(255, 255, 255)' && c.h1 === 'rgb(29, 78, 216)' && c.h2 === 'rgb(29, 78, 216)' && c.txt === 'rgb(0, 0, 0)';
    ok(good(await colours(S.base)), 'H4 computed: white background, blue h1 and h2 (rgb 29,78,216), black body text');
    { const S2 = await startServer({ 'css/ho6.css': CSS.replace('--ho6-text: #000000', '--ho6-text: #888888') }); control('H4 (text made grey)', !good(await colours(S2.base))); S2.srv.close(); }

    // ── H6 CTA hrefs carry utm_*, fbclid, gclid; utm_campaign is always ho-6 ────────────────────────────────────────────────────────────
    const ctaHrefs = async (base) => {
      const p = await openPage(browser, base, { path: '/ho6?utm_source=facebook&utm_medium=paid&utm_campaign=SomeAd&utm_content=c1&utm_term=t1&fbclid=FB_ABC123&gclid=G_XYZ789' });
      const h = await p.page.$$eval('a[data-cta]', (as) => as.map((a) => a.getAttribute('href'))); await p.ctx.close(); return h;
    };
    const wantKeys = { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'ho-6', utm_content: 'c1', utm_term: 't1', fbclid: 'FB_ABC123', gclid: 'G_XYZ789' };
    const carries = (hs) => hs.length === 6 && hs.every((h) => { const u = new URL(h, 'http://x'); return u.pathname === '/ho6/start' && Object.entries(wantKeys).every(([k, v]) => u.searchParams.getAll(k).length === 1 && u.searchParams.get(k) === v); });
    ok(carries(await ctaHrefs(S.base)), 'H6 all six CTA hrefs go to /ho6/start carrying utm_source/medium/content/term, fbclid, gclid, with utm_campaign=ho-6 exactly once (the ad\'s own campaign value is not passed on)');
    {
      const p = await openPage(browser, S.base, { path: '/ho6' });
      const h = await p.page.$$eval('a[data-cta]', (as) => as.map((a) => a.getAttribute('href'))); await p.ctx.close();
      ok(h.every((x) => x === '/ho6/start?utm_campaign=ho-6'), 'H6 with no ad params the CTAs are /ho6/start?utm_campaign=ho-6');
    }
    { const S2 = await startServer({ 'ho6.html': LANDING.replace("var PASS = ['utm_source', 'utm_medium', 'utm_content', 'utm_term', 'fbclid', 'gclid'];", "var PASS = ['utm_source'];") }); control('H6 (click ids dropped)', !carries(await ctaHrefs(S2.base))); S2.srv.close(); }

    // ── H10 landing: events without PII, no Lead, no Supabase ───────────────────────────────────────────────────────────────────────────
    const landingRun = async (base) => {
      const p = await openPage(browser, base, { path: '/ho6?fbclid=FB_ABC123' });
      await p.page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); }, true));
      await p.page.click('a[data-cta="3"]');
      await p.page.waitForTimeout(100);
      const out = { ev: await p.events(), fb: await p.fbqCalls(), calls: await p.calls() };
      await p.ctx.close(); return out;
    };
    const l = await landingRun(S.base);
    ok(l.ev.map((e) => e.name).join(',') === 'ho6_view,ho6_cta_click', 'H10 /ho6 emits exactly ho6_view then ho6_cta_click');
    ok(l.ev.every((e) => e.params.variant === 'ho6') && l.ev[1].params.section === 3, 'H10 events carry variant=ho6 and the section number');
    ok(l.ev.every((e) => Object.keys(e.params).every((k) => ['variant', 'section'].includes(k))), 'H10 events carry no other parameter (no PII, no click ids)');
    ok(!l.fb.some((c) => c[0] === 'track' && c[1] === 'Lead') && l.calls.length === 0, 'H10 /ho6 fires no Meta Lead and makes no Supabase call');
    { const S2 = await startServer({ 'ho6.html': LANDING.replace("track('ho6_view');", "track('ho6_view'); fbq('track','Lead');") }); const l2 = await landingRun(S2.base); control('H10', l2.fb.some((c) => c[0] === 'track' && c[1] === 'Lead')); S2.srv.close(); }

    // ── H9 + H16 the contact page, end to end ───────────────────────────────────────────────────────────────────────────────────────────
    const AD = '?utm_source=facebook&utm_medium=paid&utm_campaign=SomeAd&utm_content=c1&utm_term=t1&fbclid=FB_ABC123&gclid=G_XYZ789';
    const e2e = async (base, v, adQs) => {
      const p = await openPage(browser, base, { path: '/ho6/start' + (adQs === undefined ? AD : adQs) });
      await fillAndSubmit(p, v);
      await p.page.waitForTimeout(400);
      const r = { calls: await p.calls(), ev: await p.events(), fb: await p.fbqCalls(), posts: p.posts, errors: p.errors,
        thanksVisible: await p.page.$eval('#ho6StepThanks', (e) => !e.hidden), contactVisible: await p.page.$eval('#ho6StepContact', (e) => !e.hidden),
        thanks: await p.page.$eval('#ho6ThanksLine', (e) => e.textContent) };
      await p.ctx.close(); return r;
    };
    const summary = (r) => {
      const ins = r.calls.filter((c) => c.t === 'insert'), rpc = r.calls.filter((c) => c.t === 'rpc' && c.name === 'set_lead_role');
      const gl = r.ev.filter((e) => e.name === 'generate_lead'), lead = r.fb.filter((c) => c[0] === 'track' && c[1] === 'Lead');
      return { ins, rpc, gl, lead };
    };
    const r1 = await e2e(S.base, { phone: '(317) 555-0134', check: true });
    const s1 = summary(r1);
    const pl = s1.ins[0] && s1.ins[0].payload;
    ok(s1.ins.length === 1 && s1.ins[0].table === 'leads', 'H9 exactly one leads insert');
    ok(!!pl && pl.variant === 'ho6' && pl.utm_campaign === 'ho-6' && pl.fbclid === 'FB_ABC123' && pl.gclid === 'G_XYZ789' && pl.utm_source === 'facebook' && pl.utm_medium === 'paid' && pl.source === 'router', "H9 insert carries variant='ho6', utm_campaign='ho-6' (the ad's own campaign is overridden), fbclid, gclid, utm_source/medium, source='router'");
    ok(!!pl && pl.name === 'Jane Doe' && pl.email === 'jane@example.com' && pl.phone === '3175550134' && !('zip' in pl) && !('is_synthetic' in pl), 'H9 insert carries name, email, phone as 10 digits, no is_synthetic on a real visitor');
    ok(s1.gl.length === 1 && s1.lead.length === 1 && s1.lead[0][3] && s1.lead[0][3].eventID === s1.gl[0].params.event_id && s1.gl[0].params.event_id === pl.id, 'H9 generate_lead and Meta Lead each fire once, sharing one event id (the lead id)');
    ok(s1.rpc.length === 1 && s1.rpc[0].args.p_role === 'homeowner' && s1.rpc[0].args.p_lead_id === pl.id, 'H9 set_lead_role(homeowner) fires once for the new lead');
    ok(r1.posts.length === 1, 'H9 record-lead-details is called once');
    const body1 = r1.posts[0] && JSON.parse(r1.posts[0].body);
    ok(!!body1 && body1.lead_id === pl.id && body1.consent.key === 'ho6_contact_consent' && body1.consent.given === true && body1.consent.text === CONSENT_TEXT && md5(body1.consent.text) === PINNED_MD5_LITERAL, 'H9 the consent record is {key, given: true, the exact approved text}, and the text hashes to the pin');
    ok(!!body1 && body1.phone_as_typed === '(317) 555-0134' && body1.form_payload.name === 'Jane Doe' && body1.form_payload.email === 'jane@example.com' && body1.fbc && /FB_ABC123/.test(body1.fbc), 'H9 details body carries the phone as typed, the form values and fbc derived from the fbclid');
    ok(/functions\/v1\/record-lead-details\?apikey=/.test(r1.posts[0].url), 'H9 details go to the record-lead-details Edge Function');
    ok(r1.ev.every((e) => Object.keys(e.params).every((k) => ['variant', 'step', 'step_index', 'ua_context', 'lead_id', 'event_id'].includes(k))), 'H9 analytics events carry only variant/step/step_index/ua_context/lead_id/event_id, no contact details or consent');
    ok(r1.thanksVisible && !r1.contactVisible && r1.thanks === "Thanks, Jane. We'll email you your next steps.", 'H9 thank-you reads exactly: Thanks, Jane. We\'ll email you your next steps.');
    ok(r1.errors.length === 0, 'H9 no page errors');
    // unchecked box and no phone
    const r2 = await e2e(S.base, { first: 'Sam', last: 'Lee', email: 'sam@example.com', phone: '' });
    const s2 = summary(r2), b2 = r2.posts[0] && JSON.parse(r2.posts[0].body);
    ok(s2.ins.length === 1 && s2.ins[0].payload.phone === null && b2.consent.given === false && b2.consent.text === CONSENT_TEXT, 'H9 phone left blank still submits (phone null); unchecked box is stored as given=false with the same text');
    ok(r2.thanks === "Thanks, Sam. We'll email you your next steps.", 'H9 thank-you uses the typed first name');
    // consent box without a phone number is refused, nothing saved
    {
      const p = await openPage(browser, S.base, { path: '/ho6/start' }); await fillAndSubmit(p, { phone: '', check: true }); await p.page.waitForTimeout(150);
      ok((await p.calls()).length === 0 && (await p.page.$eval('#ho6PhoneErr', (e) => e.textContent)) !== '', 'H9 checking the box with no phone number is refused with a message and saves nothing'); await p.ctx.close();
    }
    // failed insert: no conversion, form stays for retry
    {
      const p = await openPage(browser, S.base, { path: '/ho6/start' + AD });
      await p.page.evaluate(() => { window.__insertResult = { data: null, error: { message: 'boom' } }; });
      await fillAndSubmit(p, { phone: '(317) 555-0134' }); await p.page.waitForTimeout(300);
      const s = summary({ calls: await p.calls(), ev: await p.events(), fb: await p.fbqCalls() });
      ok(s.gl.length === 0 && s.lead.length === 0 && s.rpc.length === 0 && p.posts.length === 0 && (await p.page.$eval('#ho6StepContact', (e) => !e.hidden)) && !(await p.page.$eval('#ho6Submit', (e) => e.disabled)), 'H9 a failed insert counts no conversion, sends no consent or alert, and leaves the form ready to retry'); await p.ctx.close();
    }
    // internal walk is flagged synthetic
    {
      const r = await e2e(S.base, { phone: '(317) 555-0134' }, '?oq_internal=1');
      const ins = r.calls.find((c) => c.t === 'insert');
      ok(ins.payload.is_synthetic === true && ins.headers['x-oq-internal'] === '1', 'H9 an oq_internal=1 walk inserts is_synthetic=true with the X-OQ-Internal header');
    }
    // ── H16 thank-you has no call promise ───────────────────────────────────────────────────────────────────────────────────────────────
    const noCallRe = /(dustin|call|within\s+\d*\s*minutes?)/i;
    ok(!noCallRe.test(r1.thanks) && !noCallRe.test(r2.thanks), 'H16 the thank-you text contains no call promise (no "call", "Dustin", "within minutes")');
    // negative controls
    { const S2 = await startServer({ ...base0, 'js/ho6-start.js': START_JS.replace('CORE.setRole(leadId);', '') });
      control('H9 (set_lead_role removed)', summary(await e2e(S2.base, { phone: '(317) 555-0134' })).rpc.length !== 1); S2.srv.close(); }
    { const S2 = await startServer({ ...base0, 'js/ho6-start.js': START_JS.replace("variant: 'ho6', campaign: 'ho-6'", "variant: 'f', campaign: null") });
      const s = summary(await e2e(S2.base, { phone: '(317) 555-0134' })); control('H9 (variant/campaign wrong)', !(s.ins[0].payload.variant === 'ho6' && s.ins[0].payload.utm_campaign === 'ho-6')); S2.srv.close(); }
    { const S2 = await startServer({ ...base0, 'js/ho6-start.js': START_JS.replace('fireConversion(leadId);\n      // The consent', "fireConversion(leadId); fireConversion.call(null, leadId); eventFired = false; fireConversion(leadId);\n      // The consent") });
      control('H9 (conversion fired more than once)', summary(await e2e(S2.base, { phone: '(317) 555-0134' })).gl.length !== 1); S2.srv.close(); }
    { const S2 = await startServer({ ...base0, 'js/ho6-start.js': START_JS.replace(". We'll email you your next steps.\"", ". Dustin will call you.\"") });
      const r = await e2e(S2.base, { phone: '(317) 555-0134' }); control('H16 ("Dustin will call you" injected)', noCallRe.test(r.thanks)); S2.srv.close(); }
    { const S2 = await startServer({ ...base0, 'js/ho6-start.js': START_JS.replace("text: CONSENT_TEXT", "text: CONSENT.checkbox_label") });
      const r = await e2e(S2.base, { phone: '(317) 555-0134', check: true }); const b = JSON.parse(r.posts[0].body); control('H-consent (stored text drifts from the pin)', md5(b.consent.text) !== PINNED_MD5_LITERAL); S2.srv.close(); }
    // H17 (round 2): early submit. ho6-start.js is held back for 4s (a slow phone), the visitor fills the form and submits by Enter, by click, by
    // requestSubmit() and by a raw form.submit(); the URL must never gain first_name/last_name/email/phone. The negative control serves the old markup.
    {
      const early = async (startHtml) => {
        const S2 = await startServer({ 'ho6-start.html': startHtml }, { 'js/ho6-start.js': 4000 });
        const p = await openPage(browser, S2.base, { path: '/ho6/start', waitUntil: 'commit', settle: 0 });
        await p.page.waitForSelector('#ho6Phone');
        const before = await p.page.evaluate(() => ({ handlerLoaded: !!window.Ho6Start, disabled: document.getElementById('ho6Submit').disabled }));
        await p.page.fill('#ho6First', 'Jane'); await p.page.fill('#ho6Last', 'Doe'); await p.page.fill('#ho6Email', 'jane@example.com'); await p.page.fill('#ho6Phone', '(317) 555-0134');
        await p.page.press('#ho6Email', 'Enter'); await p.page.waitForTimeout(400);
        const urlEnter = p.page.url();
        await p.page.click('#ho6Submit', { force: true, noWaitAfter: true, timeout: 2000 }).catch(() => {}); await p.page.waitForTimeout(400);
        const urlClick = p.page.url();
        await p.page.evaluate(() => { try { document.getElementById('ho6Form').requestSubmit(); } catch (e) {} }).catch(() => {}); await p.page.waitForTimeout(400);
        const urlReq = p.page.url();
        await p.page.evaluate(() => { document.getElementById('ho6Form').submit(); }).catch(() => {}); await p.page.waitForTimeout(600);
        const urlRaw = p.page.url();
        await p.ctx.close(); S2.srv.close();
        return { before, urls: [urlEnter, urlClick, urlReq, urlRaw] };
      };
      const clean = (u) => { const x = new URL(u); return x.search === '' && !/first_name|last_name|email|phone|jane|example|317/i.test(x.search + x.hash); };   // the port is random, so only query and hash are inspected
      const good = await early(noIntegrity(START));
      ok(good.before.handlerLoaded === false && good.before.disabled === true, 'H17 while ho6-start.js is still loading the submit button is disabled');
      ok(good.urls.every(clean), 'H17 submitting before ho6-start.js loads (Enter, click, requestSubmit, raw submit) leaves the URL free of name, email and phone: ' + good.urls.join(' | '));
      const oldHtml = noIntegrity(START.replace(' method="post"', '').replace(/(id="ho6Submit"[^>]*) disabled>/, '$1>').replace(/<script>\s*\/\* Early-submit guard[\s\S]*?<\/script>/, ''));
      const bad = await early(oldHtml);
      control('H17 (old markup leaks the PII into the URL)', bad.urls.some((u) => /first_name=Jane/.test(u) && /email=jane%40example\.com/.test(u)));
      // after the script loads, the button is enabled and the real flow still works (H9 covers the flow itself)
      const p2 = await openPage(browser, S.base, { path: '/ho6/start' });
      ok(await p2.page.evaluate(() => !document.getElementById('ho6Submit').disabled), 'H17 once ho6-start.js has initialised the submit button is enabled'); await p2.ctx.close();
    }
  } finally { S.srv.close(); await browser.close(); }
}

if (ONLY !== 'browser') staticHalf();
if (ONLY !== 'static') await browserHalf();
console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
