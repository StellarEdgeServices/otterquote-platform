/**
 * gh-3266 follow-up (Dustin, 2026-11-02: "Move it up") -- headless-Chromium
 * measurement + guard for the homeowner "Create Your Account" step
 * (app /get-started?v=d, step 2).
 *
 * Asserts that the whole "Continue with Google" button is above the fold
 * (bottom edge <= window height) at 1366x657 (a real laptop window with
 * Chrome UI) and at 390x844, both with the phone captured by the router lead
 * and with the phone skipped (phone input shown), and that the consent rules
 * still hold at every size: SMS box present, unchecked, not required, before
 * the Create My Account button in DOM order; the Terms/Privacy line is the
 * button's next sibling; no horizontal overflow.
 *
 * Safe by construction: only the local server is reachable (every other
 * request is aborted), get_lead_prefill is stubbed, and nothing is submitted.
 * The direct-visitor form (name/email inputs shown) is MEASURED and printed
 * but not asserted: it is below the fold by design (see PR #3271).
 *
 * Usage:  node tests/gh3266-fold-playwright.mjs
 *   BASE_URL=http://127.0.0.1:3111  use an already running react-app server;
 *   otherwise `next start` is spawned from react-app/ (run `next build` first).
 * Negative control: run against a checkout from before this change (main at
 * dc239428): the phone-skipped 1366x657 case fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'react-app');
let chromium;
try { ({ chromium } = createRequire(path.join(here, 'e2e', 'package.json'))('playwright')); }
catch {
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
  catch { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }
}

let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

const waitFor = (url, ms) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => http.get(url, r => { r.resume(); res(); })
    .on('error', () => (Date.now() - t0 > ms ? rej(new Error('server did not start')) : setTimeout(tick, 500)));
  tick();
});

let server = null;
let BASE = process.env.BASE_URL;
if (!BASE) {
  const port = 3100 + Math.floor(Math.random() * 400);
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'],
    { cwd: APP, stdio: 'ignore', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
}
const origin = new URL(BASE).origin;

const SIZES = [
  { name: '1366x657', w: 1366, h: 657, asserted: true },
  { name: '1366x768', w: 1366, h: 768, asserted: true },
  { name: '390x844', w: 390, h: 844, asserted: true },
];
const CASES = [
  { name: 'phone captured', lead: { name: 'Jane Smith', email: 'jane@example.com', phone: '3175551234' }, asserted: true },
  { name: 'phone skipped', lead: { name: 'Jane Smith', email: 'jane@example.com', phone: '' }, asserted: true },
  { name: 'direct visitor', lead: null, asserted: false },
];

async function measure(browser, size, c) {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (c.lead && /\/rest\/v1\/rpc\/get_lead_prefill/.test(u)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([c.lead]) });
    }
    return route.abort();
  });
  const q = c.lead ? '?v=d&oq_internal=1&lead=11111111-1111-4111-8111-111111111111' : '?v=d&oq_internal=1';
  await page.goto(`${BASE}/get-started${q}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#street', '123 Main St');
  await page.fill('#city', 'Zionsville');
  await page.selectOption('#state', { index: 1 }).catch(() => {});
  await page.fill('#zip', '46077');
  if (c.lead) await page.waitForTimeout(800); // let the stubbed prefill land before Continue
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.getByRole('heading', { name: 'Create Your Account', exact: true }).waitFor({ timeout: 15000 });
  if (c.lead) await page.getByTestId('signing-up-as').waitFor({ timeout: 5000 });
  const r = await page.evaluate(() => {
    const rect = el => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
    const btns = [...document.querySelectorAll('button')];
    const google = btns.find(b => /continue with google/i.test(b.textContent || ''));
    const submit = btns.find(b => (b.textContent || '').trim() === 'Create My Account');
    const sms = document.getElementById('sms-consent');
    const legal = submit && submit.nextElementSibling;
    return {
      google: google ? rect(google) : null,
      submit: submit ? rect(submit) : null,
      smsPresent: !!sms, smsChecked: sms ? sms.checked : null, smsRequired: sms ? sms.required : null,
      smsBeforeSubmit: !!(sms && submit && (sms.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING)),
      legalText: legal ? legal.textContent.replace(/\s+/g, ' ').trim() : null,
      phoneShown: !!document.getElementById('phone'),
      hOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await ctx.close();
  return r;
}

try {
  if (server) await waitFor(`${BASE}/get-started`, 60000);
  const browser = await chromium.launch();
  for (const size of SIZES) {
    for (const c of CASES) {
      const m = await measure(browser, size, c);
      const label = `${size.name} / ${c.name}`;
      console.log(`MEASURE ${label}: google bottom=${m.google && m.google.bottom}px (height ${m.google && m.google.height}) submit bottom=${m.submit && m.submit.bottom}px phoneInputShown=${m.phoneShown}`);
      ok(!!m.google && !!m.submit, `${label}: Google and Create My Account buttons render`);
      ok(m.smsPresent && m.smsChecked === false && m.smsRequired === false && m.smsBeforeSubmit, `${label}: SMS consent present, unchecked, not required, before Create My Account`);
      ok(m.legalText === 'By creating an account, you agree to our Terms of Service and Privacy Policy.', `${label}: Terms/Privacy line is the submit button's next sibling`);
      ok(!m.hOverflow, `${label}: no horizontal overflow`);
      if (c.lead) ok(m.phoneShown === !c.lead.phone, `${label}: phone input ${c.lead.phone ? 'hidden' : 'shown'} as designed`);
      if (c.asserted && size.asserted && m.google) {
        ok(m.google.bottom <= size.h, `${label}: Google sign-in fully above the fold (bottom ${m.google.bottom} <= ${size.h})`);
      }
    }
  }
  await browser.close();
} finally {
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
