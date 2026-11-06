/**
 * gh-3471 (P23 / D-419) clauses (3) and (4): a recorded, repo-committed walkthrough of the homeowner path to the measurement
 * checkout, in real headless Chromium (390x844 phone viewport, 1280x800 for the desktop nav), with no new customer wording.
 *
 *   A  (clause 3)  Homepage -> /start -> app get-started -> trade-selector -> project-info -> dashboard -> help-measurements ->
 *                  the card form is shown. Passes on the PR head. Negative control: with the dashboard's route to
 *                  help-measurements.html removed (served copy only), the SAME script fails at the named step
 *                  "dashboard: a way to the measurement".
 *   B  (clause 4)  Starts signed out (how-it-works.html) on the guest-nav "Measurements" link, signs up, and must land back on
 *                  help-measurements.html. On main (e5759c57 and later until this PR) it fails at the named step
 *                  "lands back on help-measurements.html" because it lands on dashboard.html.
 *   C  (return flag safety) allowlist only, no open redirect, nothing bypassed:
 *        C1 a ?return= that is not an allowlisted token (URL, //host, javascript:, __proto__, wrong case) goes nowhere;
 *        C2 a valid token sends a signed-in homeowner on to help-measurements.html;
 *        C3 the dashboard's state gate (D-344, TX) still shows and the token is NOT followed;
 *        C4 a signed-out visitor with a valid token is still sent to sign up, not to the measurement page.
 *
 * Hermetic: otterquote.com is served from THIS repo through Playwright routing; app.otterquote.com is the repo's react-app, built
 * (`next build`, stub Supabase env) and served by `next start` on a free local port; Supabase auth/REST/functions and Stripe are
 * stubbed; every other host is aborted. Nothing touches production or a real Stripe. The stubs assume email auto-confirm (the
 * production default noted in get-started/page.tsx): signUp returns a live session.
 *
 * Run: (cd tests/e2e && npm ci) && (cd react-app && npm ci) && node tests/gh3471-path-walkthrough.mjs     Exit 0 = all green.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const REACT = path.join(ROOT, 'react-app');
const require = createRequire(path.join(here, 'e2e', 'package.json'));
const { chromium } = require('playwright');

const SB_HOST = 'yeszghaspzwwstvsrioa.supabase.co';
const UID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = 'cccccccc-0000-4000-8000-000000000001';
const STEP_TIMEOUT = { timeout: 10000 };
const NAMED_DASH_STEP = 'dashboard: a way to the measurement';
const NAMED_RETURN_STEP = 'lands back on help-measurements.html';

let pass = 0; let fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

// supabase-js 2.116.0 UMD: tests/e2e's own dependency in CI, else the react-app copy. The page's CDN tag (and its SRI) is swapped for it.
const UMD = [path.join(here, 'e2e/node_modules/@supabase/supabase-js/dist/umd/supabase.js'), path.join(REACT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')].find((p) => fs.existsSync(p));
if (!UMD) throw new Error('supabase-js UMD not found (run npm ci in tests/e2e or react-app)');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const STRIPE = "window.Stripe=function(){return {elements:function(){return {create:function(){return {mount:function(s){var e=document.querySelector(s);if(e)e.setAttribute('data-stub-card','1');},on:function(){},destroy:function(){}}}}},confirmCardPayment:function(){return Promise.resolve({paymentIntent:{status:'succeeded',id:'pi_stub'}})}}};";

// ── the react-app, built with a stub Supabase env and served on a free port ──
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const STUB_ENV = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'https://' + SB_HOST, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_stub', NEXT_TELEMETRY_DISABLED: '1' };
async function startApp() {
  const nextBin = path.join(REACT, 'node_modules/.bin/next');
  if (!fs.existsSync(nextBin)) throw new Error('react-app dependencies missing (run npm ci in react-app)');
  if (!fs.existsSync(path.join(REACT, '.next/BUILD_ID'))) {
    const b = spawnSync(nextBin, ['build'], { cwd: REACT, env: STUB_ENV, encoding: 'utf8' });
    if (b.status !== 0) throw new Error('next build failed:\n' + (b.stdout || '').slice(-1500) + (b.stderr || '').slice(-1500));
  }
  const port = await freePort();
  const child = spawn(nextBin, ['start', '-p', String(port), '-H', '127.0.0.1'], { cwd: REACT, env: STUB_ENV, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/get-started'); if (r.status === 200) return { port, child }; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
  child.kill(); throw new Error('next start did not come up');
}

// ── per-run world: a session, the claim row and the stubbed Supabase ──
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function makeSession() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'walk@example.com', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email', role: 'homeowner' }, user_metadata: { role: 'homeowner' }, identities: [{ id: UID, user_id: UID, provider: 'email' }], created_at: new Date().toISOString() };
  const access_token = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, email: user.email, role: 'authenticated', aud: 'authenticated', exp }) + '.sig';
  return { user, session: { access_token, refresh_token: 'rt_stub', token_type: 'bearer', expires_in: 3600, expires_at: exp, user } };
}
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' }, body: JSON.stringify(body) }); }

async function newWorld(browser, appPort, opts) {
  opts = opts || {};
  const { user, session } = makeSession();
  const world = { claim: null, profile: null, signedUp: false, unhandled: [] };
  const context = await browser.newContext({ viewport: opts.desktop ? { width: 1280, height: 800 } : { width: 390, height: 844 }, isMobile: !opts.desktop, hasTouch: !opts.desktop });
  if (opts.signedIn) {
    await context.addCookies([{ name: 'sb-otterquote-at', value: encodeURIComponent(session.access_token), domain: '.otterquote.com', path: '/', secure: true }, { name: 'sb-otterquote-rt', value: 'rt_stub', domain: '.otterquote.com', path: '/', secure: true }]);
    await context.addInitScript((s) => { try { if (!localStorage.getItem('sb-otterquote-auth')) localStorage.setItem('sb-otterquote-auth', s); } catch (e) { /* storage blocked */ } }, JSON.stringify(session));
    world.claim = { id: CLAIM_ID, user_id: UID, property_address: '123 Main St, Zionsville, IN, 46077', property_state: opts.state || 'IN', trades: ['roofing'], funding_type: 'insurance', job_type: 'insurance_rcv' };
    world.profile = { id: UID, first_name: 'Walk', last_name: 'Tester', email: 'walk@example.com', role: 'homeowner' };
  }
  await context.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const h = u.hostname;
    if (u.pathname === '/__supabase.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(UMD) });
    if (h === 'otterquote.com' || h === 'www.otterquote.com') {
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith('/get-started')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script>location.replace("https://app.otterquote.com/get-started")</script>' }); // stands in for the Netlify 301 (a fulfilled 301 leaves the app shell without its chunks); the query is NOT relied on
      if (p === '/') p = '/index.html';
      if (p === '/start') p = '/start.html';
      let f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) return route.fulfill({ status: 404, body: 'nf' });
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (fs.existsSync(f + '.html')) f = f + '.html'; else return route.fulfill({ status: 404, body: 'nf' }); }
      let buf = fs.readFileSync(f);
      if (path.extname(f) === '.html') {
        let html = buf.toString('utf8');
        html = html.replace(/<script([^>]*)src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"[^>]*>/g, '<script src="/__supabase.js">');
        if (opts.mutation === 'cut-dashboard-link' && path.basename(f) === 'dashboard.html') html = html.split("data: 'help-measurements.html'").join("data: 'dashboard.html'");
        buf = Buffer.from(html);
      }
      return route.fulfill({ status: 200, headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }, body: buf });
    }
    if (h === 'app.otterquote.com') {
      try { const r = await route.fetch({ url: 'http://127.0.0.1:' + appPort + u.pathname + u.search }); return route.fulfill({ response: r }); } catch (e) { return route.fulfill({ status: 502, body: String(e) }); }
    }
    if (h === SB_HOST) return sbStub(world, session, user, route, req, u);
    if (h === 'js.stripe.com') return route.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE });
    if (h === 'cdn.jsdelivr.net' && u.pathname.includes('supabase-js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(UMD) });
    return route.abort();
  });
  return { context, world };
}

async function sbStub(world, session, user, route, req, u) {
  const m = req.method(); const p = u.pathname;
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (p === '/auth/v1/signup') { world.signedUp = true; world.profile = { id: UID, first_name: 'Walk', last_name: 'Tester', email: 'walk@example.com', role: 'homeowner' }; return json(route, 200, session); }
  if (p === '/auth/v1/token') return json(route, 200, session);
  if (p === '/auth/v1/user') return json(route, 200, user);
  if (p === '/auth/v1/logout') return json(route, 204, {});
  const rest = p.match(/^\/rest\/v1\/(.+)$/);
  if (rest) {
    const t = rest[1];
    if (t.startsWith('rpc/')) return json(route, 200, null);
    const accept = req.headers().accept || '';
    let rows = [];
    if (t === 'claims' && world.claim) rows = [world.claim];
    if (t === 'profiles' && world.profile) rows = [world.profile];
    if (m === 'POST' || m === 'PATCH') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* not json */ }
      if (Array.isArray(body)) body = body[0] || {};
      if (t === 'claims') { world.claim = Object.assign({ id: CLAIM_ID, user_id: UID }, world.claim || {}, body); rows = [world.claim]; }
      if (t === 'profiles') { world.profile = Object.assign({ id: UID }, world.profile || {}, body); rows = [world.profile]; }
      if (!/return=representation/.test(req.headers().prefer || '')) return json(route, 201, null);
    }
    if (/vnd.pgrst.object/.test(accept)) { if (!rows.length) return json(route, 406, { code: 'PGRST116', message: '0 rows', details: '', hint: null }); return json(route, 200, rows[0]); }
    return json(route, 200, rows);
  }
  if (p === '/functions/v1/create-payment-intent') return json(route, 200, { client_secret: 'pi_stub_secret_stub', payment_intent_id: 'pi_stub', amount: 2263 });
  world.unhandled.push(m + ' ' + p);
  return json(route, 200, {});
}

// ── a named-step runner: the first failing step stops the run and is what the result names ──
function stepper(page, label) {
  const r = { failed: null, detail: '', finalUrl: '' };
  r.step = async (name, fn) => {
    if (r.failed) return;
    try { await fn(); console.log('  [' + label + '] PASS step ' + name + ' -> ' + page.url()); }
    catch (e) { r.failed = name; r.finalUrl = page.url(); r.detail = String(e.message).split('\n')[0].slice(0, 160); console.log('  [' + label + '] FAIL step ' + name + ' -> ' + page.url() + ' | ' + r.detail); }
  };
  return r;
}

// the sign-up half shared by A and B: get-started address, account, then the trade-selector wizard and project-info Save
async function signUpAndIntake(page, s) {
  await s.step('get-started: address', async () => { await page.waitForURL(/app\.otterquote\.com\/get-started/, STEP_TIMEOUT); await page.locator('#street').waitFor(STEP_TIMEOUT); await page.fill('#street', '123 Main St'); await page.fill('#city', 'Zionsville'); await page.selectOption('#state', 'IN'); await page.fill('#zip', '46077'); await page.click('button[type=submit]'); await page.locator('#first-name').waitFor(STEP_TIMEOUT); });
  await s.step('get-started: account created, lands in the wizard', async () => { await page.fill('#first-name', 'Walk'); await page.fill('#last-name', 'Tester'); await page.fill('#email', 'walk@example.com'); await page.fill('#password', 'Passw0rd!stub'); await page.click('button[type=submit]'); await page.waitForURL(/trade-selector/, STEP_TIMEOUT); await page.locator('text=Insurance Claim').first().waitFor(STEP_TIMEOUT); });
  await s.step('wizard: pay question, policy, trade, replace', async () => { await page.click('text=Insurance Claim'); await page.waitForTimeout(600); await page.click('text=Replacement Cost Value'); await page.click('button:has-text("Continue")'); await page.click('text=Roofing'); await page.click('button:has-text("Continue")'); await page.locator('text=Full replacement').waitFor(STEP_TIMEOUT); await page.click('text=Full replacement'); await page.click('button:has-text("Continue")'); await page.waitForURL(/project-info-rcv/, { timeout: 15000 }); });
  await s.step('project info: save and continue', async () => { await page.click('#pi-submit'); await page.waitForURL(/(dashboard|help-measurements)\.html/, STEP_TIMEOUT); });
}

// ── A: homepage to the measurement checkout form ──
async function walkA(browser, appPort, mutation) {
  const { context } = await newWorld(browser, appPort, { mutation });
  const page = await context.newPage(); const s = stepper(page, 'A' + (mutation ? '/' + mutation : ''));
  await s.step('homepage loads', async () => { await page.goto('https://otterquote.com/?oq_internal=1', { waitUntil: 'domcontentloaded' }); await page.locator('#hr-hero-go').waitFor(STEP_TIMEOUT); });
  await s.step('hero CTA leads to /start', async () => { await page.click('#hr-hero-go'); await page.waitForURL(/\/start/, STEP_TIMEOUT); await page.locator('input[type=email]:visible').waitFor(STEP_TIMEOUT); });
  await s.step('start: email then name', async () => { await page.locator('input[type=email]:visible').fill('walk@example.com'); await page.locator('button:visible:has-text("Continue")').click(); await page.locator('#dName').waitFor(STEP_TIMEOUT); });
  await s.step('start: contact hands off to the app', async () => { await page.fill('#dName', 'Walk Tester'); await page.locator('button:visible:has-text("Continue")').click(); await page.waitForURL(/app\.otterquote\.com\/get-started/, STEP_TIMEOUT); });
  await signUpAndIntake(page, s);
  await s.step('dashboard reached', async () => { if (!/dashboard\.html/.test(page.url())) throw new Error('not on the dashboard: ' + page.url()); });
  await s.step(NAMED_DASH_STEP, async () => { const link = page.locator('a[href="help-measurements.html"]').first(); await link.waitFor(STEP_TIMEOUT); await link.click(); await page.waitForURL(/help-measurements/, STEP_TIMEOUT); });
  await s.step('measurements: choose the aerial report', async () => { await page.click('.path-card:has-text("Aerial Roof Report")'); await page.locator('#purchaseHoverBtn').waitFor(STEP_TIMEOUT); });
  await s.step('measurements: checkout form shown', async () => { await page.click('#purchaseHoverBtn'); await page.locator('#hoverPaymentForm').waitFor({ state: 'visible', timeout: 8000 }); });
  await context.close();
  return s;
}

// ── B: signed out on the guest-nav "Measurements" link, back at the measurement page after sign-up ──
async function walkB(browser, appPort) {
  const { context } = await newWorld(browser, appPort, { desktop: true });
  const page = await context.newPage(); const s = stepper(page, 'B');
  await s.step('how-it-works page loads signed out (guest nav)', async () => { await page.goto('https://otterquote.com/how-it-works.html?oq_internal=1', { waitUntil: 'domcontentloaded' }); await page.locator('#site-header a[href="/help-measurements.html"]').first().waitFor(STEP_TIMEOUT); });
  await s.step('guest nav "Measurements" click sends them to sign up', async () => { await page.locator('#site-header a[href="/help-measurements.html"]').first().click(); await page.waitForURL(/app\.otterquote\.com\/get-started/, STEP_TIMEOUT); });
  await signUpAndIntake(page, s);
  await s.step(NAMED_RETURN_STEP, async () => { await page.waitForURL(/otterquote\.com\/help-measurements\.html/, { timeout: 8000 }); });
  await s.step('measurements: the choice screen is shown', async () => { await page.locator('#pathSelection').waitFor({ state: 'visible', timeout: 8000 }); });
  await context.close();
  return s;
}

// ── C: the return flag cannot be abused ──
async function walkC(browser, appPort) {
  // settled = the main frame's URL has not changed for 2 s (max 12 s): no fixed sleep, so a slow redirect chain cannot race the check
  const settle = async (page) => {
    let last = ''; let same = 0;
    for (let i = 0; i < 48 && same < 8; i++) { await page.waitForTimeout(250); const u = page.url(); if (u === last) same++; else { same = 0; last = u; } }
    return new URL(page.url());
  };
  // C1: tokens that are not on the allowlist go nowhere
  for (const bad of ['https://evil.example/', '//evil.example', 'javascript:alert(1)', '__proto__', 'constructor', 'MEASUREMENTS', 'measurements/../x', '/help-measurements.html']) {
    const { context } = await newWorld(browser, appPort, { signedIn: true });
    const page = await context.newPage(); const hosts = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) hosts.push(new URL(f.url()).hostname); });
    await page.goto('https://otterquote.com/dashboard.html?return=' + encodeURIComponent(bad), { waitUntil: 'domcontentloaded' });
    const u = await settle(page);
    ok(u.pathname === '/dashboard.html' && hosts.every((h) => h === 'otterquote.com'), 'C1 ?return=' + bad + ' is ignored: stays on the dashboard, no other host visited (' + u.hostname + u.pathname + ')');
    await context.close();
  }
  // C2: a valid token forwards a signed-in homeowner
  { const { context } = await newWorld(browser, appPort, { signedIn: true }); const page = await context.newPage();
    await page.goto('https://otterquote.com/dashboard.html?return=measurements', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/help-measurements\.html/, { timeout: 10000 }).catch(() => {});
    ok(new URL(page.url()).pathname === '/help-measurements.html', 'C2 ?return=measurements forwards a signed-in homeowner to help-measurements.html (' + page.url() + ')'); await context.close(); }
  // C3: the D-344 state gate still runs first and the token is not followed
  { const { context } = await newWorld(browser, appPort, { signedIn: true, state: 'TX' }); const page = await context.newPage();
    await page.goto('https://otterquote.com/dashboard.html?return=measurements', { waitUntil: 'domcontentloaded' });
    await page.locator('text=available in Texas').first().waitFor({ timeout: 8000 }).catch(() => {});
    const u = await settle(page); const body = await page.innerText('body').catch(() => '');
    ok(u.pathname === '/dashboard.html' && /isn't available in Texas yet/.test(body), 'C3 a Texas homeowner with ?return=measurements still gets the state gate card and is not sent to the measurement page'); await context.close(); }
  // C4: signed out, a valid token still means sign up first
  { const { context } = await newWorld(browser, appPort, {}); const page = await context.newPage();
    await page.goto('https://otterquote.com/dashboard.html?return=measurements', { waitUntil: 'domcontentloaded' });
    const u = await settle(page);
    ok(u.hostname === 'app.otterquote.com' && u.pathname.startsWith('/get-started'), 'C4 signed out + ?return=measurements goes to sign-up, not the measurement page (' + u.hostname + u.pathname + ')'); await context.close(); }
}

const app = await startApp();
const browser = await chromium.launch();
let exitCode = 0;
try {
  console.log('--- A: homepage to the measurement checkout (clause 3)');
  const a = await walkA(browser, app.port);
  ok(a.failed === null, 'A passes: homepage -> measurement checkout form, no dead end' + (a.failed ? ' (FAILED at "' + a.failed + '": ' + a.detail + ')' : ''));
  console.log('--- A negative control: the dashboard route to help-measurements.html removed');
  const aMut = await walkA(browser, app.port, 'cut-dashboard-link');
  ok(aMut.failed === NAMED_DASH_STEP, 'A control fails at the named step "' + NAMED_DASH_STEP + '" (failed at: ' + aMut.failed + ')');
  console.log('--- B: signed-out guest-nav "Measurements" click, back at the measurement page after sign-up (clause 4)');
  const bRes = await walkB(browser, app.port);
  ok(bRes.failed === null, 'B passes: signed-out Measurements click -> sign-up -> help-measurements.html' + (bRes.failed ? ' (FAILED at "' + bRes.failed + '": ' + bRes.detail + '; final url ' + bRes.finalUrl + ')' : ''));
  console.log('--- C: the return flag is an allowlist and bypasses nothing');
  await walkC(browser, app.port);
} catch (e) {
  console.log('FAIL: harness error: ' + (e && e.stack || e)); fail++;
} finally {
  await browser.close(); app.child.kill();
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
