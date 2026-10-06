/**
 * Regression test - dashboard.html reloaded itself about every 2 s for a signed-in homeowner who also has an
 * active referral_agents row of agent_type 'customer' (found in the #2478 production walk, comment 6000634770).
 *
 * CAUSE: public.resolved_user_role ranks an active referral_agents row above "owns a claim", so such a user resolves
 * derived_role = 'customer'. dashboard.html calls Auth.requireAuth('homeowner'); 'customer' !== 'homeowner' and
 * 'customer' is not in PARTNER_ROLES, so js/auth.js (requireAuth, role-mismatch branch) fell to
 * `window.location.href = '/dashboard.html'` - the page already open - on every load.
 *
 * HOW: the REAL dashboard.html, js/auth.js, js/config.js etc. are served from this repo to headless Chromium with the
 * real supabase-js (tests/e2e's pinned copy replaces the CDN tag). Every Supabase HTTP call is answered by a local
 * stub: the session is a stored token, GET /auth/v1/user validates it, GET /rest/v1/resolved_user_role returns the
 * derived_role under test. Every non-local request is aborted. The test watches main-frame navigations for 10 s.
 *
 * ASSERTS: (1) homeowner who is a 'customer' referral partner: no navigation after the first load, the page is still
 * /dashboard.html after 10 s; (2) controls that must not change: a plain homeowner stays on /dashboard.html, a
 * contractor is still sent to /contractor-dashboard.html, a re_agent partner is still sent to /partner-dashboard.html.
 * Negative control: run on main's js/auth.js, (1) fails (the page navigates to /dashboard.html repeatedly).
 *
 * Usage: node tests/gh-dashboard-customer-referral-reload.mjs [repoRoot]      Exit 0 = pass.
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

let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
const USER = { id: '22222222-2222-4222-8222-222222222222', aud: 'authenticated', role: 'authenticated', email: 'owner@otterquote-internal.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, role: 'authenticated', email: USER.email, exp: NOW + 3600 })}.sig`;
const SESSION = { access_token: jwt, refresh_token: 'RT-1', expires_in: 3600, expires_at: NOW + 3600, token_type: 'bearer', user: USER };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

// Opens /dashboard.html signed in as USER whose resolved_user_role.derived_role is `derivedRole`.
async function watch(derivedRole, ms) {
  const ctx = await browser.newContext();
  const navs = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname.endsWith('.supabase.co')) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      const json = (body) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname === '/auth/v1/user') return json(USER);
      if (u.pathname.startsWith('/auth/v1/')) return json(SESSION);
      if (u.pathname === '/rest/v1/resolved_user_role') return json({ derived_role: derivedRole });
      if (u.pathname.startsWith('/rest/v1/')) {
        // single()/maybeSingle() ask for one object; everything else gets an empty list.
        return json(/object\+json/.test(route.request().headers()['accept'] || '') ? {} : []);
      }
      return json({});
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  // One entry per document load of the main frame (a reload or redirect adds an entry; history.replaceState does not).
  page.on('domcontentloaded', (pg) => navs.push(new URL(pg.url()).pathname));
  // Sign in the way a real magic link does (fragment tokens, validated by GET /auth/v1/user), as gh1980's harness does.
  const frag = `#access_token=${jwt}&refresh_token=RT-1&expires_in=3600&token_type=bearer&type=magiclink`;
  await page.goto(BASE + '/dashboard.html' + frag, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(ms);
  await ctx.close();
  return navs;
}

// (1) The defect: homeowner + active customer-type referral row (derived_role 'customer') must stay put for 10 s.
const customer = await watch('customer', 10000);
const show = (n) => `${n.length} load(s): ${n.slice(0, 4).join(' > ')}${n.length > 4 ? ' > ...' : ''}`;
console.log('customer navs:', show(customer));
ok(customer.length === 1 && customer[0] === '/dashboard.html', `(1) customer-type referral homeowner: one load of /dashboard.html, no reload or redirect in 10 s (${show(customer)})`);

// (2) Controls: nothing else changes.
const homeowner = await watch('homeowner', 6000);
ok(homeowner.length === 1 && homeowner[0] === '/dashboard.html', `(2a) plain homeowner stays on /dashboard.html (navs: ${homeowner.join(' > ')})`);
const contractor = await watch('contractor', 6000);
ok(contractor.includes('/contractor-dashboard.html'), `(2b) contractor is still sent to /contractor-dashboard.html (navs: ${contractor.join(' > ')})`);
const partner = await watch('re_agent', 6000);
ok(partner.includes('/partner-dashboard.html'), `(2c) re_agent partner is still sent to /partner-dashboard.html (navs: ${partner.join(' > ')})`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
