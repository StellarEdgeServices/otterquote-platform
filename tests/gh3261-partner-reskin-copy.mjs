/**
 * gh-3261 -- the partner landing pages take the approved homepage reskin (gh-2598) as a DESIGN-ONLY change: every visible string, form, tracking script and SEO tag
 * stays exactly as it was. This test proves it by comparing each in-scope page at the BASE commit with the page at HEAD.
 *
 * BASE: env GH3261_BASE, else `git merge-base HEAD origin/main` (the commit this branch started from), else origin/main. Run it on the reskin branch; on main after
 * the merge it compares main with itself.
 *
 * STATIC checks (no browser; always run):
 *   S0  HEAD == BASE + only the allowed reskin edits: removing the one gh-3261 head block (comment, gstatic preconnect, Libre Franklin link, /css/home-reskin.css,
 *       /css/partner-reskin.css) and the body class "pr" from HEAD gives BASE byte for byte
 *   S1  visible text: every text node outside <script>/<style>/<template> and comments, entity-decoded, whitespace-collapsed, in document order, plus <title>
 *   S2  alt / title / aria-label / placeholder / value attributes and <label> text
 *   S3  forms: every <form>, <input> (names, types, hidden fields, consent checkboxes, required), <select>, <option>, <textarea>, <button>, tag for tag with all attributes
 *   S4  tracking and scripts: every <script> (src and inline body, so GA4 config, the pixel gates, oq-ref / oq_pc / ref-bind code) identical and in order
 *   S5  JSON-LD blocks, <link rel="canonical">, <meta name="robots"> (noindex state), meta description / og / twitter tags identical
 * RENDERED checks (Playwright + Chromium over two local static servers, BASE extracted with `git archive`; run with --render or GH3261_RENDER=1):
 *   R1  document.body.innerText after JS (nav.js header/footer, the partners.html chooser cards), whitespace-collapsed, at 1440x900 and 390x844. innerText applies
 *       CSS text-transform and display:none, so a style that hides, shows or re-cases a string fails here even though the source text is unchanged
 *   R2  rendered alt / title / aria-label / placeholder values, <title>, form control names/types/required/checked, script srcs, canonical and robots after JS
 * NEGATIVE CONTROLS: S1 (one word changed), S2 (an aria-label changed), S3 (an input name changed; a consent checkbox removed; a hidden field added), S4 (a gate script
 * dropped), S5 (canonical changed; noindex added; JSON-LD edited), S0 (a stray word added) must each go red on a mutated copy of the real HEAD source; in render mode,
 * R1 must go red on a one-word change and on an injected text-transform, and R2 on a renamed input.
 *
 * Run: node tests/gh3261-partner-reskin-copy.mjs [--render]      Exit 0 = every check green and every control red.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const RENDER = process.argv.includes('--render') || process.env.GH3261_RENDER === '1';

export const PAGES = ['partners.html', 'partner-re.html', 'partner-influencers.html', 'partner-insurance.html', 'partner-insurance-fees.html',
  'partner-insurance-how-it-works.html', 'partner-insurance-why.html', 'partner-inspectors.html', 'partner-adjusters.html', 'partner-other.html'];

let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };
const control = (id, red) => ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source');

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
function resolveBase() {
  if (process.env.GH3261_BASE) return git('rev-parse', process.env.GH3261_BASE);
  try { return git('merge-base', 'HEAD', 'origin/main'); } catch { return git('rev-parse', 'origin/main'); }
}
const BASE = resolveBase();
console.log('BASE ' + BASE + '   HEAD ' + git('rev-parse', 'HEAD') + ' (working tree files)');
const baseSrc = (f) => execFileSync('git', ['show', BASE + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });   /* untrimmed: S0 compares bytes */
const headSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- a small HTML tokenizer (no dependency) ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', middot: '·', rarr: '→', larr: '←',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', times: '×', bull: '•', check: '✓' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>\/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
function attrs(s) { const o = {}; let m; ATTR.lastIndex = 0; while ((m = ATTR.exec(s || ''))) { let v = m[2] ?? ''; if (/^["']/.test(v)) v = v.slice(1, -1); o[m[1].toLowerCase()] = decode(v); } return o; }
function parse(html) {
  const out = { text: [], title: '', attrs: [], labels: [], controls: [], scripts: [], jsonld: [], heads: [] };
  const RAW = new Set(['script', 'style', 'template', 'textarea', 'title']);
  let m, last = 0, inBody = false, labelDepth = 0, labelBuf = '';
  TAG.lastIndex = 0;
  const pushText = (t) => { const d = decode(t); if (inBody && ws(d)) out.text.push(ws(d)); if (labelDepth) labelBuf += d; };
  while ((m = TAG.exec(html))) {
    pushText(html.slice(last, m.index)); last = TAG.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const close = m[1] === '/', name = m[2].toLowerCase(), a = attrs(m[3]);
    if (close) { if (name === 'label' && labelDepth) { labelDepth--; if (!labelDepth) { out.labels.push(ws(labelBuf)); labelBuf = ''; } } continue; }
    if (name === 'body') inBody = true;
    for (const k of ['alt', 'title', 'aria-label', 'placeholder', 'value']) if (k in a) out.attrs.push(name + '[' + k + ']=' + ws(a[k]));
    if (['form', 'input', 'select', 'option', 'button', 'textarea', 'label'].includes(name)) out.controls.push(name + ' ' + JSON.stringify(Object.entries(a).sort()));
    if (name === 'label') labelDepth++;
    if (name === 'link' || name === 'meta') {
      if ((a.rel || '').toLowerCase() === 'canonical') out.heads.push('canonical=' + a.href);
      if (name === 'meta' && (a.name || a.property)) out.heads.push('meta ' + (a.name || a.property) + '=' + (a.content ?? ''));
    }
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf('</' + name, last);
      const body = end < 0 ? '' : html.slice(last, end);
      if (name === 'script') { out.scripts.push(JSON.stringify(Object.entries(a).sort()) + ' ' + body); if ((a.type || '').includes('ld+json')) out.jsonld.push(body.trim()); }
      if (name === 'title') out.title = ws(decode(body));
      if (name === 'textarea') out.controls.push('textarea-body ' + body);
      if (end >= 0) { last = end; TAG.lastIndex = end; }
    }
  }
  pushText(html.slice(last));
  return out;
}

/* ---------- the allowed reskin edit (S0) ---------- */
const BLOCK = /<!-- gh-3261: the approved homepage reskin \(gh-2598\) on the partner landing pages\.[^\n]*-->\n<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Libre\+Franklin:wght@400;600;800&display=swap" rel="stylesheet">\n<link rel="stylesheet" href="\/css\/home-reskin\.css">\n<link rel="stylesheet" href="\/css\/partner-reskin\.css">\n(?=<\/head>)/;
const unreskin = (s) => s.replace(BLOCK, '').replace('<body class="pr">', '<body>');

function diffFirst(a, b) { const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `#${i}: base=${JSON.stringify(a[i])} head=${JSON.stringify(b[i])}`; return ''; }
function staticChecks(base, head) {
  const B = parse(base), H = parse(head);
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  return {
    S0: BLOCK.test(head) && head.includes('<body class="pr">') && unreskin(head) === base,
    S1: eq(B.text, H.text) && B.title === H.title && B.text.length > 0,
    S2: eq(B.attrs, H.attrs) && eq(B.labels, H.labels),
    S3: eq(B.controls, H.controls),
    S4: eq(B.scripts, H.scripts) && B.scripts.length > 0,
    S5: eq(B.jsonld, H.jsonld) && eq(B.heads, H.heads) && B.heads.some((h) => h.startsWith('canonical=')),
    _detail: { S1: diffFirst(B.text, H.text), S2: diffFirst(B.attrs.concat(B.labels), H.attrs.concat(H.labels)), S3: diffFirst(B.controls, H.controls), S4: diffFirst(B.scripts.map((s) => s.slice(0, 120)), H.scripts.map((s) => s.slice(0, 120))), S5: diffFirst(B.jsonld.concat(B.heads), H.jsonld.concat(H.heads)) },
  };
}
const LABELS = { S0: 'HEAD is BASE plus only the gh-3261 head block and body class', S1: 'visible text and <title> byte-identical', S2: 'alt/title/aria-label/placeholder/value and label text identical',
  S3: 'forms, inputs, hidden fields, consent checkboxes identical', S4: 'scripts (tracking, gates, ref binding) identical and in order', S5: 'JSON-LD, canonical, robots/noindex and meta tags identical' };

const sources = {};
for (const f of PAGES) {
  const base = baseSrc(f), head = headSrc(f);
  sources[f] = { base, head };
  const r = staticChecks(base, head);
  for (const k of Object.keys(LABELS)) ok(r[k], `${f} ${k} ${LABELS[k]}${r[k] || !r._detail[k] ? '' : '  first difference ' + r._detail[k]}`);
}

/* ---------- static negative controls: each mutation of a real HEAD page must turn its check red ---------- */
const mut = (f, fn) => { const { base, head } = sources[f]; const m = fn(head); if (m === head) throw new Error('control mutation did not apply on ' + f); return staticChecks(base, m); };
control('S1 one word changed ("Paid" -> "Payed", partner-insurance-fees.html)', !mut('partner-insurance-fees.html', (h) => h.replace('<div class="commission-amount">Paid</div>', '<div class="commission-amount">Payed</div>')).S1);
control('S1 one word changed in the referral-fee disclaimer (partner-re.html)', !mut('partner-re.html', (h) => h.replace('to make sure it is lawful for you to accept referral fees.', 'to make sure it is legal for you to accept referral fees.')).S1);
control('S2 an aria-label changed (partners.html)', !mut('partners.html', (h) => h.replace('aria-label="Choose your profession"', 'aria-label="Choose a profession"')).S2);
control('S3 an input name changed (partner-insurance.html)', !mut('partner-insurance.html', (h) => h.replace('name="company"', 'name="companyName"')).S3);
control('S3 the consent checkbox removed (partner-adjusters.html)', !mut('partner-adjusters.html', (h) => h.replace(/<input type="checkbox"[^>]*>/, '')).S3);
control('S3 a hidden field added (partner-inspectors.html)', !mut('partner-inspectors.html', (h) => h.replace('<form class="partner-form" id="partnerForm">', '<form class="partner-form" id="partnerForm"><input type="hidden" name="x" value="1">')).S3);
control('S4 a tracking gate dropped (partner-other.html)', !mut('partner-other.html', (h) => h.replace('<script src="/js/meta-pixel-gate.js"></script>', '')).S4);
control('S5 canonical changed (partner-influencers.html)', !mut('partner-influencers.html', (h) => h.replace('<link rel="canonical" href="https://otterquote.com/partner-influencers.html">', '<link rel="canonical" href="https://otterquote.com/partners.html">')).S5);
control('S5 noindex added (partner-insurance-why.html)', !mut('partner-insurance-why.html', (h) => h.replace('</head>', '<meta name="robots" content="noindex">\n</head>')).S5);
/* none of the in-scope pages carries JSON-LD today (S5 pins that "none" too); the control adds one, and also edits one inside a copy that has it */
control('S5 a JSON-LD block added (partner-re.html)', !mut('partner-re.html', (h) => h.replace('</head>', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>\n</head>')).S5);
{ const f = 'partner-re.html', withLd = sources[f].head.replace('</head>', '<script type="application/ld+json">{"@context":"https://schema.org"}</script>\n</head>'), baseLd = sources[f].base.replace('</head>', '<script type="application/ld+json">{"@context":"https://schema.org"}</script>\n</head>');
  control('S5 a JSON-LD value edited (partner-re.html with a block on both sides)', staticChecks(baseLd, withLd).S5 && !staticChecks(baseLd, withLd.replace('schema.org"}', 'schema.org/"}')).S5); }
control('S0 a stray word added inside the reskin edit (partner-insurance-how-it-works.html)', !mut('partner-insurance-how-it-works.html', (h) => h.replace('<body class="pr">', '<body class="pr">New')).S0);

/* ---------- rendered checks ---------- */
async function rendered() {
  let chromium;
  try { ({ chromium } = createRequire(path.join(here, 'e2e', 'package.json'))('playwright')); }
  catch { try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright')); } }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh3261-base-'));
  execFileSync('sh', ['-c', `git archive ${BASE} | tar -x -C "${baseDir}"`], { cwd: ROOT });
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
  const overrides = new Map();   // url path -> body, for the render-mode negative controls (served from the HEAD root only)
  const serve = (dir, useOverrides) => new Promise((res) => { const s = http.createServer((req, rsp) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const p = path.join(dir, u === '/' ? 'index.html' : u);
    if (useOverrides && overrides.has(u)) { rsp.writeHead(200, { 'content-type': TYPES['.html'] }); return rsp.end(overrides.get(u)); }
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
    rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(rsp); }); s.listen(0, '127.0.0.1', () => res(s)); });
  const sb = await serve(baseDir, false), sh = await serve(ROOT, true);
  const browser = await chromium.launch();
  async function snap(port, page, vp, inject) {
    const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(r.request().url()) ? r.continue() : r.abort()));
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/${page}`, { waitUntil: 'load', timeout: 60000 });
    await pg.waitForTimeout(1500);
    if (inject) await pg.addStyleTag({ content: inject });
    const r = await pg.evaluate(() => {
      const w = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const a = []; document.querySelectorAll('[alt],[title],[aria-label],[placeholder]').forEach((e) => ['alt', 'title', 'aria-label', 'placeholder'].forEach((k) => e.hasAttribute(k) && a.push(e.tagName + '[' + k + ']=' + w(e.getAttribute(k)))));
      const c = []; document.querySelectorAll('form,input,select,textarea,button').forEach((e) => c.push([e.tagName, e.getAttribute('name'), e.getAttribute('type'), e.id, e.hasAttribute('required'), e.checked === true, e.tagName === 'INPUT' && e.type === 'hidden' ? e.value : ''].join('|')));
      return { text: w(document.body.innerText), title: document.title, a, c, s: [...document.scripts].map((e) => e.getAttribute('src') || ('inline:' + e.text.length)),
        canon: [...document.querySelectorAll('link[rel=canonical]')].map((e) => e.getAttribute('href')), robots: [...document.querySelectorAll('meta[name=robots]')].map((e) => e.content) };
    });
    await ctx.close();
    return r;
  }
  const VPS = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];
  for (const f of PAGES) for (const [tag, vp] of VPS) {
    const B = await snap(sb.address().port, f, vp), H = await snap(sh.address().port, f, vp);
    ok(B.text.length > 200 && B.text === H.text && B.title === H.title, `${f} ${tag} R1 rendered innerText identical (${B.text.length} chars)${B.text === H.text ? '' : '  first difference at ' + [...B.text].findIndex((ch, i) => ch !== H.text[i]) + ': base "' + B.text.slice(Math.max(0, [...B.text].findIndex((ch, i) => ch !== H.text[i]) - 30), [...B.text].findIndex((ch, i) => ch !== H.text[i]) + 30) + '"'}`);
    ok(JSON.stringify([B.a, B.c, B.s, B.canon, B.robots]) === JSON.stringify([H.a, H.c, H.s, H.canon, H.robots]), `${f} ${tag} R2 rendered attributes, form controls, scripts, canonical and robots identical`);
  }
  /* render-mode controls */
  const page = 'partner-adjusters.html', vp = VPS[0][1];
  const B = await snap(sb.address().port, page, vp);
  overrides.set('/' + page, headSrc(page).replace('is not a public adjuster and does not negotiate', 'is not a licensed adjuster and does not negotiate'));
  control('R1 one word changed in the served HEAD page (partner-adjusters.html)', (await snap(sh.address().port, page, vp)).text !== B.text);
  overrides.set('/' + page, headSrc(page).replace('name="firstName"', 'name="first_name"'));
  { const M = await snap(sh.address().port, page, vp); control('R2 an input name changed in the served HEAD page (partner-adjusters.html)', JSON.stringify(M.c) !== JSON.stringify(B.c)); }
  overrides.clear();
  control('R1 a CSS-only change that re-cases visible text (injected h2 { text-transform: uppercase })', (await snap(sh.address().port, page, vp, 'h2 { text-transform: uppercase !important; }')).text !== B.text);
  await browser.close(); sb.close(); sh.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
}

if (RENDER) await rendered(); else console.log('SKIP: rendered checks (R1/R2) not requested; run with --render');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
