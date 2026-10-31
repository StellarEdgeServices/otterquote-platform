/**
 * gh-3267: homeowner dashboard buttons were unreadable. The Upload buttons are <button class="btn btn-secondary">, and
 * .btn-secondary sets no text colour, so they rendered the browser's black button text on the navy card (1.45:1).
 *
 * HOW: the REAL dashboard.html + css/ + js/ are served to headless Chromium, signed in, with every Supabase call answered by a
 * local stub (same harness as gh-dashboard-customer-referral-reload.mjs) and one draft insurance claim, so the
 * "Complete Your Project Details" checklist renders with both Upload buttons. Contrast is computed from the computed text
 * colour over the composited ancestor backgrounds (ancestor opacity applied, gradients sampled at every stop, worst case).
 *
 * ASSERTS:
 *   (1) every Upload button: >= 4.5:1, at rest and on hover;
 *   (2) every text element in the Project Information and Complete Your Project Details cards (emoji icons excepted),
 *       plus the "Project Details Complete N%" label: >= 4.5:1, and the disabled referral Save >= 4.5:1;
 *   (3) the progress label has a visible gap between "Project Details Complete" and the percentage.
 * NEGATIVE CONTROL: delete the gh-3267 `.checklist-actions .btn-secondary` rule from the live stylesheet (restoring the old
 * cascade) and re-measure: the Upload button must FAIL 4.5:1. Proves the assertion can see the bug.
 *
 * Usage: node tests/gh3267-dashboard-contrast.mjs [repoRoot]      Exit 0 = pass.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
const UMD_CANDIDATES = [process.env.SUPABASE_UMD,
  path.join(here, 'e2e/node_modules/@supabase/supabase-js/dist/umd/supabase.js'),
  path.join(here, '..', 'react-app/node_modules/@supabase/supabase-js/dist/umd/supabase.js')].filter(Boolean);
const UMD = UMD_CANDIDATES.find((f) => fs.existsSync(f));
if (!UMD) throw new Error('supabase-js UMD not found; tried: ' + UMD_CANDIDATES.join(', '));
let chromium;
try { ({ chromium } = createRequire(path.join(here, 'e2e', 'package.json'))('playwright')); }
catch {
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
  catch { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }
}

const AA = 4.5;
let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
const USER = { id: '22222222-2222-4222-8222-222222222222', aud: 'authenticated', role: 'authenticated', email: 'owner@otterquote-internal.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, role: 'authenticated', email: USER.email, exp: NOW + 3600 })}.sig`;
const SESSION = { access_token: jwt, refresh_token: 'RT-1', expires_in: 3600, expires_at: NOW + 3600, token_type: 'bearer', user: USER };
const PROFILE = { id: USER.id, full_name: 'Test Homeowner', role: 'homeowner' };
const CLAIM = { id: '33333333-3333-4333-8333-333333333333', user_id: USER.id, status: 'draft', created_at: '2026-10-01T00:00:00Z',
  funding_type: 'insurance', job_type: 'insurance_rcv', damage_type: 'roof', trades: ['roofing'], has_estimate: false,
  has_measurements: false, has_material_selection: false, referral_source: null, referral_code: null, referral_id: null,
  project_confirmation: null, deductible_amount: null };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__supabase.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(UMD)); }
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  const ext = path.extname(f);
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
  res.setHeader('content-type', type + (ext === '.html' || ext === '.js' ? '; charset=utf-8' : ''));
  if (ext === '.html') {
    let html = fs.readFileSync(f, 'utf8');
    html = html.replace(/<script([^>]*)src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"[^>]*>/g, '<script src="/__supabase.js">');
    return res.end(html);
  }
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === '127.0.0.1') return route.continue();
  if (u.hostname.endsWith('.supabase.co')) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/auth/v1/user') return json(USER);
    if (u.pathname.startsWith('/auth/v1/')) return json(SESSION);
    if (u.pathname === '/rest/v1/resolved_user_role') return json({ derived_role: 'homeowner' });
    const single = /object\+json/.test(route.request().headers()['accept'] || '');
    if (u.pathname === '/rest/v1/claims' && method === 'GET') return json(single ? CLAIM : [CLAIM]);
    if (u.pathname === '/rest/v1/profiles' && method === 'GET') return json(single ? PROFILE : [PROFILE]);
    if (u.pathname.startsWith('/rest/v1/rpc/')) return json([]);
    if (u.pathname.startsWith('/rest/v1/')) return json(single ? null : []);
    return json({});
  }
  return route.abort();
});
const page = await ctx.newPage();
const frag = `#access_token=${jwt}&refresh_token=RT-1&expires_in=3600&token_type=bearer&type=magiclink`;
await page.goto(BASE + '/dashboard.html' + frag, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForSelector('#checklist-container .checklist-item', { timeout: 20000 });
await page.waitForSelector('#referral-card', { timeout: 20000 });
await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });

// Contrast of `sel`'s computed text colour against its effective (composited) background. Worst gradient stop wins.
const MEASURE = (sel) => {
  const P = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const over = (t, b) => [0, 1, 2].map((i) => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
  const mix = (a, b, o) => [0, 1, 2].map((i) => a[i] * o + b[i] * (1 - o)).concat(1);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  const chain = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
  const layers = chain.map((n) => { const cs = getComputedStyle(n);
    return { bg: P(cs.backgroundColor), stops: (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(P), op: parseFloat(cs.opacity) }; });
  const gi = layers.findIndex((l) => l.stops.length);
  const tc = P(getComputedStyle(el).color);
  let worst = Infinity;
  for (const stop of gi < 0 ? [null] : layers[gi].stops) {
    const behind = [[255, 255, 255, 1]];
    layers.forEach((l, k) => { let c = behind[k]; if (l.bg) c = over(l.bg, c); if (k === gi && stop) c = over(stop, c); behind.push(c); });
    let B = behind[layers.length]; let T = over(tc, B);
    for (let k = layers.length - 1; k >= 0; k--) if (layers[k].op < 1) { T = mix(T, behind[k], layers[k].op); B = mix(B, behind[k], layers[k].op); }
    worst = Math.min(worst, ratio(T, B));
  }
  return Math.round(worst * 100) / 100;
};

// (1) Upload buttons, at rest and on hover.
const uploads = await page.$$('#checklist-container button.btn-secondary');
const uploadIdx = [];
for (let i = 0; i < uploads.length; i++) if ((await uploads[i].textContent()).trim() === 'Upload') uploadIdx.push(i);
ok(uploadIdx.length >= 2, `(1a) both Upload buttons render (found ${uploadIdx.length})`);
for (const i of uploadIdx) {
  const sel = `#checklist-container button.btn-secondary >> nth=${i}`;
  const h = await page.$(sel);
  const rest = await h.evaluate(MEASURE);
  ok(rest >= AA, `(1b) Upload #${i} at rest ${rest}:1 >= ${AA}:1`);
  await h.hover(); await page.waitForTimeout(50);
  const hov = await h.evaluate(MEASURE);
  ok(hov >= AA, `(1c) Upload #${i} on hover ${hov}:1 >= ${AA}:1`);
  await page.mouse.move(0, 0);
}

// (2) Every text element in the two cards + the progress label.
const failures = await page.evaluate((measureSrc) => {
  const MEASURE = eval(measureSrc);
  const roots = [...document.querySelectorAll('.dashboard-section')].filter((s) => /Project Information|Complete Your Project Details/.test(s.querySelector('h2')?.textContent || ''));
  roots.push(document.querySelector('.welcome-progress'));
  const bad = []; let n = 0;
  for (const r of roots) for (const el of r.querySelectorAll('*')) {
    const own = [...el.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join('').trim();
    if (!own || !el.getClientRects().length || el.classList.contains('checklist-icon')) continue;
    n++;
    const v = MEASURE(el);
    if (v < 4.5) bad.push(`${el.tagName.toLowerCase()}.${el.className} "${own.slice(0, 40)}" ${v}:1`);
  }
  return { n, bad };
}, MEASURE.toString());
ok(failures.n >= 40 && failures.bad.length === 0, `(2a) all ${failures.n} text elements in the cards >= 4.5:1${failures.bad.length ? ' -- failing: ' + failures.bad.join('; ') : ''}`);
const saveDisabled = await page.$eval('#referral-save', (e) => e.disabled);
const saveRatio = await page.$eval('#referral-save', MEASURE);
ok(saveDisabled && saveRatio >= AA, `(2b) disabled referral Save ${saveRatio}:1 >= ${AA}:1`);

// (3) The missing space: a visible gap between the label and the percentage.
const gapPx = await page.$eval('.welcome-progress .progress-label', (el) => {
  const [a, b] = el.children; return b.getBoundingClientRect().left - a.getBoundingClientRect().right;
});
ok(gapPx >= 4, `(3) "Project Details Complete" and the percentage are ${gapPx.toFixed(1)}px apart (>= 4px)`);

// NEGATIVE CONTROL: remove the gh-3267 rule -> the old cascade -> Upload must fail.
const removed = await page.evaluate(() => {
  let k = 0;
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch { continue; }
    for (let i = rules.length - 1; i >= 0; i--) if ((rules[i].selectorText || '').includes('.checklist-actions .btn-secondary')) { sh.deleteRule(i); k++; }
  }
  return k;
});
const oldRatio = await (await page.$(`#checklist-container button.btn-secondary >> nth=${uploadIdx[0]}`)).evaluate(MEASURE);
ok(removed >= 1 && oldRatio < AA, `(N1) negative control: without the gh-3267 rule (${removed} removed) Upload is ${oldRatio}:1 < ${AA}:1`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
