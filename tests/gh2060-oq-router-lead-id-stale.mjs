/**
 * gh-2060 (Kevin's Q 5881020422 item 6) -- executable stale-state harness for sessionStorage.oq_router_lead_id.
 *
 * WHAT THE KEY DOES (start.html):
 *   write  insertFreshLead() .then -> setStoredLeadId(newId)   (EVERY arm's insert, incl. bridge.insertFreshLead)
 *   read   step1Form submit handler -> getStoredLeadId(); if set, update_lead_contact(p_lead_id, name, email, phone)
 *          instead of inserting; `false`/error from the RPC falls back to insertFreshLead.
 *   clear  ONLY the bfcache `pageshow` (e.persisted) handler removes it. No clear on Step-1 success, redirect or completion.
 *   The stored value has no owner and no timestamp.
 *
 * HOW IT IS EXERCISED: the REAL start.html is served from this repo over a local HTTP server into headless Chromium.
 * Every non-local request (CDN, fonts, analytics) is aborted; window.supabase is replaced by a recording stub, so the
 * page's own submit handler, insertFreshLead, sessionStorage code and pageshow handler all run unmodified. The Step-1
 * form is driven with form.requestSubmit() (see REACHABILITY below for why it is not clicked).
 *
 * REACHABILITY (recorded, asserted): #step1Form is the shared arm A/B form. Arms A/B are not in LIVE_VARIANTS, so real
 * traffic (d/e, f by opt-in) never sees it; the arm modules call bridge.insertFreshLead() and never read the key. The
 * read site is therefore unreachable for a real visitor today, and the leak below is latent -- it becomes live the
 * moment arm A/B (or any arm using this handler) is served. A check pins that fact so a flip trips this suite.
 *
 * SEMANTICS: `check` = current correct behaviour (must pass). `knownGap` = the recommended-safe behaviour, EXPECTED TO
 * FAIL today (suite stays green, prints KNOWN GAP); the run FAILS when one starts passing ("KNOWN GAP CLOSED") so the
 * ledger entry gets converted. Same convention as tests/gh2060-static-surfaces-staleness.mjs.
 *
 * NEGATIVE CONTROLS (run in-process on MUTATED COPIES of start.html served through route interception; product files
 * are never touched):
 *   M1 remove the pageshow clearing        -> the "bfcache restore clears ..." check must go RED
 *   M2 add an ownership check (a "fix")    -> the known-gap must flip ("KNOWN GAP CLOSED") while the legit-resubmit checks stay GREEN
 *
 * Run: node tests/gh2060-oq-router-lead-id-stale.mjs      Exit 0 = green.
 * Playwright resolves from tests/e2e (CI: `npm ci` there + `npx playwright install chromium`), else the global install.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
function loadPlaywright() {
  const roots = [path.join(__dirname, 'e2e', 'package.json'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'x.js')];
  for (const r of roots) { try { return createRequire(r)('playwright'); } catch (e) { /* next */ } }
  throw new Error('playwright not resolvable (run `npm ci` in tests/e2e)');
}
const { chromium } = loadPlaywright();

const START_HTML = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');
const KEY = 'oq_router_lead_id';
const STRANGER_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_A = { name: 'Alice Owner', email: 'alice@example.com', phone: '(415) 555-2671' };
const VISITOR_B = { name: 'Bob Newcomer', email: 'bob@example.com', phone: '(212) 555-3982' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/start') p = '/start.html';
      const file = path.join(repoRoot, p);
      if (!file.startsWith(repoRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Recording supabase stub, installed before any page script. window.__rpcMode: 'true' | 'false' | 'error'.
function stubInit(seedId) {
  return `
    window.__calls = []; window.__rpcMode = 'true';
    ${seedId ? `try { sessionStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(seedId)}); } catch (e) {}` : ''}
    var mk = function () { return new Proxy(function () {}, { get: function (t, k) { if (k === 'then') return undefined; return mk(); }, apply: function () { return Promise.resolve({ data: null, error: null }); } }); };
    var client = {
      auth: mk(),
      from: function (table) { return { insert: function (payload) {
        window.__calls.push({ kind: 'insert', table: table, payload: payload });
        var p = { setHeader: function () { return p; }, then: function (a, b) { return Promise.resolve({ data: null, error: null }).then(a, b); } };
        return p; } }; },
      rpc: function (name, args) {
        window.__calls.push({ kind: 'rpc', name: name, args: args });
        if (window.__rpcMode === 'error') return Promise.resolve({ data: null, error: { message: 'boom' } });
        return Promise.resolve({ data: window.__rpcMode === 'true', error: null });
      }
    };
    window.supabase = { createClient: function () { return client; } };
  `;
}

async function openStart(browser, base, { seedId, mutate, query = '?v=d' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  await page.addInitScript(stubInit(seedId));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1') return route.abort();
    if (mutate && u.pathname === '/start') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mutate(START_HTML) });
    return route.continue();
  });
  await page.goto(base + '/start' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof CONFIG !== 'undefined');
  return { page, context, pageErrors };
}

async function submitStep1(page, who) {
  await page.evaluate((w) => {
    document.getElementById('routerName').value = w.name;
    document.getElementById('routerEmail').value = w.email;
    document.getElementById('routerPhone').value = w.phone;
    document.getElementById('step1Form').requestSubmit();
  }, who);
  await page.waitForFunction(() => !document.getElementById('step1Submit').disabled);
}
const calls = (page) => page.evaluate(() => window.__calls.slice());
const stored = (page) => page.evaluate((k) => sessionStorage.getItem(k), KEY);
const digits = (s) => s.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

// ---- suite (parameterised by a start.html mutation so the negative controls reuse it) ----
async function runSuite(browser, base, mutate) {
  const results = [];
  async function check(name, fn) {
    try { await fn(); results.push({ kind: 'pass', name }); }
    catch (e) { results.push({ kind: 'fail', name, msg: e.message }); }
  }
  async function knownGap(name, fn) {
    try { await fn(); results.push({ kind: 'gap-closed', name }); }
    catch (e) {
      if (e instanceof assert.AssertionError) results.push({ kind: 'gap', name, msg: e.message });
      else results.push({ kind: 'fail', name, msg: 'harness error (not an assertion): ' + e.message });
    }
  }
  const open = (o) => openStart(browser, base, Object.assign({ mutate }, o));

  // REACHABILITY
  // Static pin: the read site only becomes live if arm A or B is served. Assert LIVE_VARIANTS names neither, so
  // re-adding A/B next to the current arms (e.g. ['a','d','e']) trips this suite even though ?v=d still renders D.
  await check('reachability: LIVE_VARIANTS in start.html serves neither arm A nor arm B (the only arms that show #step1Form)', async () => {
    const m = START_HTML.match(/var LIVE_VARIANTS\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'LIVE_VARIANTS declaration not found in start.html -- re-anchor this pin');
    const arms = (m[1].match(/'([a-z])'/g) || []).map((x) => x.slice(1, 2));
    assert.ok(arms.length >= 1, 'LIVE_VARIANTS parsed empty: ' + m[0]);
    assert.ok(!arms.includes('a') && !arms.includes('b'), 'arm A/B is live -- the oq_router_lead_id leak is now reachable: ' + m[0]);
  });
  await check('reachability: on the live arm the shared arm A/B Step-1 form is not visible to a real visitor (read site is latent)', async () => {
    const { page, context } = await open({});
    try { assert.equal(await page.locator('#step1Form').isVisible(), false); } finally { await context.close(); }
  });

  // (b) legit same-visitor resubmit
  await check('first Step-1 submit inserts a lead and stores its id in sessionStorage (no update RPC)', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      const c = await calls(page);
      const ins = c.filter((x) => x.kind === 'insert');
      assert.equal(ins.length, 1, 'one insert: ' + JSON.stringify(c));
      assert.equal(ins[0].table, 'leads');
      assert.equal(c.filter((x) => x.name === 'update_lead_contact').length, 0);
      assert.equal(await stored(page), ins[0].payload.id, 'stored id equals inserted id');
    } finally { await context.close(); }
  });

  await check('same visitor resubmits within the window: the stored id IS reused via update_lead_contact (dedup), no second insert', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      const firstId = await stored(page);
      await submitStep1(page, { name: 'Alice Corrected', email: VISITOR_A.email, phone: VISITOR_A.phone });
      const c = await calls(page);
      assert.equal(c.filter((x) => x.kind === 'insert').length, 1, 'still exactly one insert');
      const up = c.filter((x) => x.name === 'update_lead_contact');
      assert.equal(up.length, 1);
      assert.equal(up[0].args.p_lead_id, firstId);
      assert.equal(up[0].args.p_name, 'Alice Corrected');
      assert.equal(up[0].args.p_phone, digits(VISITOR_A.phone));
      assert.equal(await stored(page), firstId, 'id unchanged');
    } finally { await context.close(); }
  });

  await check('resubmit where update_lead_contact returns false (server 30-min/prefill guard) falls back to a fresh insert and re-stores the NEW id', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      const firstId = await stored(page);
      await page.evaluate(() => { window.__rpcMode = 'false'; });
      await submitStep1(page, VISITOR_A);
      const c = await calls(page);
      const ins = c.filter((x) => x.kind === 'insert');
      assert.equal(ins.length, 2);
      assert.notEqual(ins[1].payload.id, firstId);
      assert.equal(await stored(page), ins[1].payload.id);
    } finally { await context.close(); }
  });

  await check('resubmit where update_lead_contact errors falls back to a fresh insert', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      await page.evaluate(() => { window.__rpcMode = 'error'; });
      await submitStep1(page, VISITOR_A);
      const ins = (await calls(page)).filter((x) => x.kind === 'insert');
      assert.equal(ins.length, 2);
      assert.equal(await stored(page), ins[1].payload.id);
    } finally { await context.close(); }
  });

  // (a) different visitor's stale id. Actual behaviour today is recorded in the known-gap's failure reason.
  // Recommended-safe expectation: EXPECTED TO FAIL TODAY.
  await knownGap('a stored lead id this page did not create (stale/other visitor) is never sent to update_lead_contact; a fresh lead is inserted instead', async () => {
    const { page, context } = await open({ seedId: STRANGER_ID });
    try {
      await submitStep1(page, VISITOR_B);
      const c = await calls(page);
      assert.equal(c.filter((x) => x.name === 'update_lead_contact' && x.args.p_lead_id === STRANGER_ID).length, 0,
        'stranger id ' + STRANGER_ID + ' was sent to update_lead_contact with new contact details');
      const ins = c.filter((x) => x.kind === 'insert');
      assert.equal(ins.length, 1);
      assert.notEqual(ins[0].payload.id, STRANGER_ID);
    } finally { await context.close(); }
  });

  // (c) clearing
  await check('bfcache restore (pageshow persisted) clears the stored id, and the next submit inserts fresh instead of updating', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      assert.ok(await stored(page));
      await page.evaluate(() => { const e = new Event('pageshow'); e.persisted = true; window.dispatchEvent(e); });
      assert.equal(await stored(page), null, 'key must be removed on a persisted pageshow');
      await submitStep1(page, VISITOR_A);
      const c = await calls(page);
      assert.equal(c.filter((x) => x.kind === 'insert').length, 2);
      assert.equal(c.filter((x) => x.name === 'update_lead_contact').length, 0);
    } finally { await context.close(); }
  });

  await check('a non-persisted pageshow does NOT clear the stored id', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      const id = await stored(page);
      await page.evaluate(() => { const e = new Event('pageshow'); e.persisted = false; window.dispatchEvent(e); });
      assert.equal(await stored(page), id);
    } finally { await context.close(); }
  });

  await check('CURRENT BEHAVIOUR: nothing clears the id on Step-1 success/completion -- it survives until the tab closes or a bfcache restore', async () => {
    const { page, context } = await open({});
    try {
      await submitStep1(page, VISITOR_A);
      const id = await stored(page);
      assert.ok(id);
      await page.waitForTimeout(200);
      assert.equal(await stored(page), id);
    } finally { await context.close(); }
  });

  return results;
}

// ---- negative-control mutations (applied to a COPY served through route interception only) ----
function mutateOrThrow(src, from, to, label) {
  if (!src.includes(from)) throw new Error('mutation anchor missing (' + label + ') -- start.html changed, update the control');
  return src.replace(from, to);
}
const M1_NO_CLEAR = (src) => mutateOrThrow(src, "try { sessionStorage.removeItem(LEAD_ID_STORAGE_KEY); } catch (e3) {}", '/* M1: clearing removed */', 'M1');
// "Fix": only reuse an id this JS context itself inserted (in-memory ownership).
const M2_OWNER_CHECK = (src) => {
  let s = mutateOrThrow(src, "try { return sessionStorage.getItem(LEAD_ID_STORAGE_KEY); } catch (e) { return null; }",
    "try { var v = sessionStorage.getItem(LEAD_ID_STORAGE_KEY); return (v && v === window.__oqOwnedLeadId) ? v : null; } catch (e) { return null; }", 'M2a');
  s = mutateOrThrow(s, "try { sessionStorage.setItem(LEAD_ID_STORAGE_KEY, id); }", "window.__oqOwnedLeadId = id; try { sessionStorage.setItem(LEAD_ID_STORAGE_KEY, id); }", 'M2b');
  return s;
};

function report(results, indent = '') {
  let fails = 0, gaps = 0, passes = 0;
  for (const r of results) {
    if (r.kind === 'pass') { passes++; console.log(`${indent}✓ PASS: ${r.name}`); }
    else if (r.kind === 'gap') { gaps++; console.log(`${indent}⚠ KNOWN GAP (Q on #2060 item 6, expected to fail today): ${r.name}\n${indent}    reason: ${r.msg}`); }
    else if (r.kind === 'gap-closed') { fails++; console.log(`${indent}✗ FAIL: KNOWN GAP CLOSED -- ${r.name} now passes; convert it to a normal check() and flip the ledger entry to tested.`); }
    else { fails++; console.log(`${indent}✗ FAIL: ${r.name}\n${indent}  ${r.msg}`); }
  }
  return { fails, gaps, passes };
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
let failures = 0;
try {
  console.log('== real start.html ==');
  const real = report(await runSuite(browser, base, null));
  failures += real.fails;

  console.log('\n== negative control M1: pageshow clearing removed (expect the bfcache-clear check RED) ==');
  const m1 = await runSuite(browser, base, M1_NO_CLEAR);
  report(m1, '  [M1] ');
  const m1Red = m1.some((r) => r.kind === 'fail' && r.name.startsWith('bfcache restore (pageshow persisted) clears'));
  if (m1Red) console.log('✓ PASS: control M1 detected -- removing the clearing turns the clear check RED');
  else { failures++; console.log('✗ FAIL: control M1 NOT detected -- the harness cannot see a missing clear'); }

  console.log('\n== negative control M2: ownership check added (expect the known gap to flip, legit resubmit still green) ==');
  const m2 = await runSuite(browser, base, M2_OWNER_CHECK);
  report(m2, '  [M2] ');
  const m2Flip = m2.some((r) => r.kind === 'gap-closed');
  const m2Legit = m2.some((r) => r.kind === 'pass' && r.name.startsWith('same visitor resubmits within the window'));
  if (m2Flip && m2Legit) console.log('✓ PASS: control M2 detected -- an owner check flips the known gap and keeps the legit dedup resubmit green');
  else { failures++; console.log(`✗ FAIL: control M2 NOT detected (flip=${m2Flip}, legitGreen=${m2Legit})`); }

  console.log(`\n${real.passes} passed, ${real.gaps} known gap(s), ${failures} failed.`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
