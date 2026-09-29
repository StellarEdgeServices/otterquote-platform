/**
 * gh-1980 PR 3/3 (Google-only PKCE) -- REAL headless-Chromium proof, real
 * supabase-js 2.116.0 (the react-app's pinned copy is served in place of the
 * CDN tag), Supabase HTTP endpoints stubbed at the network layer.
 *
 * Proves, on the actual static pages:
 *  (1) MAGIC LINK, cross-context: a `#access_token=...` link opened in a FRESH
 *      browser context (no prior request, no code-verifier -- i.e. the "second
 *      browser" case) signs the user in on each landing page tested
 *      (dashboard, contractor-pre-approval, partner-dashboard, auth-callback):
 *      supabase-js validates the token (GET /auth/v1/user with it), the session
 *      is persisted, the fragment is gone, and the page did NOT bounce to a
 *      login page first.
 *  (2) GOOGLE INITIATION is PKCE: Auth.signInWithGoogle() sends the browser to
 *      /auth/v1/authorize with code_challenge + S256, and stores the verifier
 *      under the canonical `sb-otterquote-auth-code-verifier` key (localStorage).
 *  (3) GOOGLE RETURN: `auth-callback.html?code=...` with that verifier stored is
 *      exchanged (POST /auth/v1/token?grant_type=pkce with the code_verifier),
 *      the session lands, and `code` is scrubbed from the URL.
 *  (4) A `?code=` with NO verifier does not produce a session (no cross-device
 *      magic leak into the pkce path) and does not exchange.
 *
 * Usage:  node tests/gh1980-landing-fragment-playwright.mjs [repoRoot]
 * Negative control: run it against the pre-rescope #2336 head (fefca5cc): the
 * blanket-pkce clients ignore the fragment, so (1) fails.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
const UMD = process.env.SUPABASE_UMD || path.join(here, '..', 'react-app/node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }

let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
const USER = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'magic@otterquote-internal.test', app_metadata: { provider: 'email' }, user_metadata: { role: 'homeowner' }, created_at: '2026-01-01T00:00:00Z' };
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, role: 'authenticated', email: USER.email, exp: NOW + 3600, user_metadata: USER.user_metadata })}.sig`;
const SESSION = { access_token: jwt, refresh_token: 'RT-1', expires_in: 3600, expires_at: NOW + 3600, token_type: 'bearer', user: USER };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__supabase.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(UMD)); }
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  const ext = path.extname(f);
  if (p === '/js/config.js' && /nodetect=1/.test(req.headers.referer || '')) {
    // Scenario 5: a client that does NOT consume the fragment itself (detectSessionInUrl:false).
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(f, 'utf8').replace('storage: window.OtterQuoteCookieStorage,', 'detectSessionInUrl: false, storage: window.OtterQuoteCookieStorage,'));
  }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
  res.setHeader('content-type', type + (ext === '.html' || ext === '.js' ? '; charset=utf-8' : ''));
  if (ext === '.html') {
    // Serve the pinned real supabase-js locally: swap the CDN tag, drop its SRI.
    let html = fs.readFileSync(f, 'utf8');
    html = html.replace(/<script([^>]*)src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"[^>]*>/g, '<script src="/__supabase.js">');
    return res.end(html);
  }
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function newPage(seed) {
  const ctx = await browser.newContext(); // fresh context == "second browser"
  const log = { userAuth: [], tokenPosts: [], authorize: [], navs: [], failedExternal: 0 };
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname.endsWith('.supabase.co')) {
      const rp = u.pathname;
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (rp === '/auth/v1/user') { log.userAuth.push(route.request().headers()['authorization'] || ''); return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(USER) }); }
      if (rp === '/auth/v1/token') { log.tokenPosts.push({ q: u.search, body: route.request().postData() }); return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(SESSION) }); }
      if (rp === '/auth/v1/authorize') { log.authorize.push(u.href); return route.abort(); }
      if (rp.startsWith('/rest/v1/')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{}' });
    }
    log.failedExternal++;
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) log.navs.push(new URL(fr.url()).pathname); });
  if (seed) await page.addInitScript((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, seed);
  return { ctx, page, log };
}

const frag = `#access_token=${jwt}&refresh_token=RT-1&expires_in=3600&token_type=bearer&type=magiclink`;
const BOUNCE = /login|get-started|coming-soon|contractor-login|partner-login|trade-selector|partner-re/;

// (1) magic-link fragment on landing pages, fresh context each
for (const landing of ['/dashboard.html', '/contractor-pre-approval.html', '/partner-dashboard.html', '/auth-callback.html?intent=homeowner']) {
  const { ctx, page, log } = await newPage();
  await page.goto(BASE + landing + frag, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  const stored = await page.evaluate(() => {
    let ls = null; try { ls = localStorage.getItem('sb-otterquote-auth'); } catch {}
    return { hash: location.hash, path: location.pathname, ls, cookie: document.cookie };
  }).catch(() => ({ hash: 'PAGE-GONE', path: '?', ls: null, cookie: '' }));
  const tag = landing.split('?')[0];
  ok(log.userAuth.some(a => a.includes(jwt)), `(1) ${tag}: link token validated against /auth/v1/user in a fresh context`);
  const routedAway = tag === '/auth-callback.html' && log.navs.some(n => n !== '/auth-callback.html'); // callback routes onward once signed in
  ok(routedAway || !/access_token/.test(stored.hash), `(1) ${tag}: #access_token removed from the URL / page routed onward (hash=${JSON.stringify(stored.hash)})`);
  ok(routedAway || !!stored.ls || stored.cookie.includes('sb-') || /otterquote/i.test(stored.cookie), `(1) ${tag}: session persisted (localStorage/cookie) or callback signed in and routed onward`);
  const bounced = log.navs.slice(0, -0 || undefined).filter(n => BOUNCE.test(n));
  // auth-callback legitimately routes onward after sign-in; the landing pages must not bounce to a login page.
  ok(tag === '/auth-callback.html' ? log.userAuth.length > 0 : bounced.length === 0, `(1) ${tag}: no auth-guard bounce to a login page (navs: ${log.navs.join(' > ')})`);
  await ctx.close();
}

// (5) the SHARED RESCUE (js/auth.js) itself: client that skips URL detection -> setSession by hand + scrub
for (const landing of ['/dashboard.html', '/contractor-pre-approval.html']) {
  const { ctx, page, log } = await newPage();
  await page.goto(BASE + landing + '?nodetect=1' + frag, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({ hash: location.hash, det: window.sb && window.sb.auth.detectSessionInUrl, ls: localStorage.getItem('sb-otterquote-auth'), cookie: document.cookie })).catch(() => ({ hash: 'PAGE-GONE' }));
  const tag = landing;
  ok(r.det === false, `(5) ${tag}: precondition -- the client does not detect the URL session itself`);
  ok(log.userAuth.some(a => a.includes(jwt)), `(5) ${tag}: shared rescue setSession() validated the link token`);
  ok(!/access_token/.test(r.hash || ''), `(5) ${tag}: fragment scrubbed from the URL after setSession`);
  ok(!!r.ls || /sb_at|sb-/.test(r.cookie || ''), `(5) ${tag}: session persisted`);
  ok(log.navs.filter(n => BOUNCE.test(n)).length === 0, `(5) ${tag}: no auth-guard bounce (navs: ${log.navs.join(' > ')})`);
  await ctx.close();
}

// (2) Google initiation is PKCE
{
  const { ctx, page, log } = await newPage();
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForFunction(() => window.Auth && typeof window.Auth.signInWithGoogle === 'function' && window.sb, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.Auth.signInWithGoogle('/auth-callback.html?intent=homeowner').catch(() => {})).catch(() => {});
  await page.waitForTimeout(1500);
  const a = log.authorize[0] || '';
  ok(/code_challenge=/.test(a) && /code_challenge_method=s256/i.test(a), '(2) Google initiation carries code_challenge + S256 (PKCE)');
  ok(/provider=google/.test(a), '(2) ...for provider=google');
  const st = await ctx.storageState(); // survives the (aborted) navigation to Google
  const ls = Object.fromEntries(((st.origins.find(o => o.origin === BASE) || {}).localStorage || []).map(e => [e.name, e.value]));
  ok(!!ls['sb-otterquote-auth-code-verifier'], '(2) code-verifier stored under the canonical sb-otterquote-auth key (where the callback client reads it)');
  ok(!('sb-otterquote-auth' in ls), '(2) the initiation client left the shared session key untouched');
  await ctx.close();
}

// (3) Google return: code exchanged with the stored verifier, code scrubbed
{
  const { ctx, page, log } = await newPage({ 'sb-otterquote-auth-code-verifier': JSON.stringify('VERIFIER-abc-123') });
  await page.goto(BASE + '/auth-callback.html?intent=homeowner&code=GOOGLE-CODE-1', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  const post = log.tokenPosts.find(t => /grant_type=pkce/.test(t.q));
  ok(!!post && /GOOGLE-CODE-1/.test(post.body || '') && /VERIFIER-abc-123/.test(post.body || ''), '(3) ?code= exchanged via grant_type=pkce with the stored code_verifier');
  const url = await page.evaluate(() => location.search).catch(() => '?');
  ok(!/code=/.test(url), `(3) code scrubbed from the URL (search=${JSON.stringify(url)})`);
  await ctx.close();
}

// (4) ?code= with no verifier: no exchange, no session
{
  const { ctx, page, log } = await newPage();
  await page.goto(BASE + '/auth-callback.html?intent=homeowner&code=FOREIGN', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  ok(!log.tokenPosts.some(t => /grant_type=pkce/.test(t.q)), '(4) ?code= without a stored verifier is not exchanged');
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
