/**
 * gh-1339 (REVIEW 6898001468) -- REAL headless-Chromium proof that contractor-bid-form.html requires and WRITES the Section 2
 * declarations on a multi-trade retail wizard bid whenever roofing is in the wizard queue, and tags trade_type from the queue
 * instead of the hidden input's default "roofing".
 *
 * Before: _showWizardTrade() hides valueAddsSection after the roofing step, validateValueAddDeclarations() returned true on
 * visibility alone, buildValueAddDeclarations() returned null, so a wizard roofing bid wrote NO declarations, and a gutters-only
 * wizard bid went out with trade_type "roofing". The DB guard in PR #3711 would refuse both.
 *
 * Same harness as tests/gh3569-wizard-roofing-price-field.mjs (real page from this repo over local HTTP, non-local requests
 * aborted, stub Supabase client, Auth.requireAuth stubbed). The real validateValueAddDeclarations() is NOT stubbed here; only the
 * D-199 template gate and non-Section-2 required attributes are cleared.
 *
 * Run: (cd tests/e2e && npm ci) && node tests/gh1339-wizard-section2-declarations.mjs      Exit 0 = all green.
 * Negative control: ROOT=<checkout of main before this change> node tests/gh1339-wizard-section2-declarations.mjs  (expected exit 1)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let chromium;
try { chromium = createRequire(path.join(here, 'e2e', 'package.json'))('playwright').chromium; }
catch (e) { chromium = createRequire(import.meta.url)('playwright').chromium; }

let fail = 0;
const ok = (cond, label) => { if (!cond) fail++; console.log((cond ? 'PASS: ' : 'FAIL: ') + label); };

const CPA_VERSION = (fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8').match(/const CURRENT_CPA_VERSION = '([^']+)'/) || [])[1];
const NEEDLE = 'Please enter your total bid price.';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      let body = fs.readFileSync(file);
      // The page's own auth gate is not under test: hand it a contractor user.
      if (p === '/js/auth.js') body = Buffer.concat([body, Buffer.from('\n;window.Auth.requireAuth = async function () { return { id: "user-1", email: "c@example.com" }; };\n')]);
      // The stub SDK replaces the CDN script, so its SRI hash must not apply.
      if (p === '/contractor-bid-form.html') body = Buffer.from(body.toString('utf8').replace(/(supabase-js@[^"]*"[^>]*?)\s+integrity="[^"]*"/, '$1'));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A chainable stand-in for the Supabase client. Tables return fixed rows; everything else resolves empty.
const STUB_SDK = `
window.__writes = [];
window.supabase = { createClient: function () {
  var ROWS = window.__ROWS;
  function builder(table) {
    var b = {};
    ['select','eq','neq','in','is','not','order','limit','gt','gte','lt','lte','ilike','like','or','filter','match','range','contains'].forEach(function (m) { b[m] = function () { return b; }; });
    ['update','insert','upsert','delete'].forEach(function (m) { b[m] = function (payload) { window.__writes.push({ table: table, method: m, payload: payload }); return b; }; });
    var wrote = null;
    ['update','insert','upsert'].forEach(function (m) { var w = b[m]; b[m] = function (payload) { wrote = Array.isArray(payload) ? payload[0] : payload; return w(payload); }; });
    var one = function () { if (wrote) return Promise.resolve({ data: Object.assign({ id: 'new-' + table }, wrote), error: null }); var r = ROWS[table]; return Promise.resolve({ data: r === undefined ? null : r, error: r === undefined ? { message: 'none' } : null }); };
    b.single = one; b.maybeSingle = one;
    b.then = function (res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); };
    return b;
  }
  return {
    from: builder,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    functions: { invoke: function () { return Promise.resolve({ data: null, error: null }); } },
    storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: null }); }, getPublicUrl: function () { return { data: { publicUrl: '' } }; }, createSignedUrl: function () { return Promise.resolve({ data: null, error: null }); } }; } },
    channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
    removeChannel: function () {},
    auth: {
      initializePromise: Promise.resolve(),
      getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: null }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      refreshSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    }
  };
} };
`;



const ROWS_SECTION2 = { gutterOption: 'none', chimneyType: 'na', skylights: 'na', iceWaterShield: 'not_applicable', dripEdgeOption: 'na' };
const FIVE = ['gutters', 'chimney', 'skylights', 'ice_water_shield', 'drip_edge'];

function rows(trades) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: trades.includes('siding') ? '2026-01-01T00:00:00Z' : null, job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades, service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false }
  };
}
const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; let n = e; while (n) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement; } return e.getBoundingClientRect().width > 0; })()`;

async function open(browser, base, trades) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(trades));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  if (process.env.DBG) { page.on('console', (m) => console.log('   [console]', m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 200))); }
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  return { context, page, dialogs };
}
const fillIf = async (page, sel, v) => { if (await page.evaluate(vis(sel))) await page.fill(sel, v); };
const selectIf = async (page, sel, v) => { if (await page.evaluate(vis(sel))) await page.selectOption(sel, v); };

async function fillRoofingStep(page) {
  await page.fill('#retailBidPrice', '15800');
  await fillIf(page, '#brandProduct', 'GAF Timberline HDZ');
  await fillIf(page, '#startDate', new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  await selectIf(page, '#completionTime', '1-2 days');
  await selectIf(page, '#numStories', '1');
  await fillIf(page, '#deckingPricePerSheet', '85');
  await fillIf(page, '#fullRedeckPrice', '4200');
}
async function declareAll(page) {
  await page.evaluate((r) => { Object.entries(r).forEach(([n, v]) => document.querySelector('input[type="radio"][name="' + n + '"][value="' + v + '"]').click()); }, ROWS_SECTION2);
}
async function submit(page) {
  await page.evaluate(() => {
    document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
    window.checkBidCanSubmitGate = async () => ({ can_submit: true });
  });
  await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(1500);
}
const quoteRow = async (page) => {
  const w = (await page.evaluate(() => window.__writes)).filter((x) => x.table === 'quotes' && (x.method === 'insert' || x.method === 'upsert'));
  return w.length ? (Array.isArray(w[0].payload) ? w[0].payload[0] : w[0].payload) : null;
};
const decl = (row) => { try { return JSON.parse(row.scope_summary).declarations || null; } catch (e) { return null; } };
const wizardToStep3 = async (page) => {
  for (let i = 0; i < 4; i++) { await page.evaluate(() => wizardNext()); await page.waitForTimeout(250); if (await page.evaluate(() => wizardStep === 3)) return true; }
  return false;
};

const { chromium: _c } = { chromium };
const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  // 1. Multi-trade wizard, roofing + gutters. Submit WITHOUT declaring Section 2: refused, no row, sent back to the roofing step.
  {
    const name = 'wizard roofing+gutters, Section 2 untouched';
    console.log('--- ' + name);
    const { context, page } = await open(browser, base, ['roofing', 'gutters']);
    ok(await page.evaluate(vis('#wizardStep1Card')), name + ': opens the wizard at step 1');
    await page.click('#wizardStep1Next'); await page.waitForTimeout(300);
    await fillRoofingStep(page);
    await page.evaluate(() => wizardNext()); await page.waitForTimeout(250);
    await fillIf(page, '#gutter6InchPrice', '2400');
    ok(await wizardToStep3(page), name + ': reaches step 3');
    ok(!(await page.evaluate(vis('#valueAddsSection'))), name + ': Section 2 is hidden on step 3 (the defect precondition)');
    await submit(page);
    const row = await quoteRow(page);
    ok(!row, name + ': NO quotes row is written without declarations');
    ok(await page.evaluate(() => wizardStep === 2 && document.getElementById('wizardTradeLabel').textContent === 'ROOFING'), name + ': contractor is taken back to the roofing step');
    ok(await page.evaluate(vis('#gutterOptionRowError')), name + ': the per-row Section 2 message is visible there');

    // 1b. Declare every row on the roofing step, return to step 3, submit: row written WITH the five declarations.
    const nm = 'wizard roofing+gutters, Section 2 declared';
    await declareAll(page);
    await page.evaluate(() => wizardNext()); await page.waitForTimeout(250);
    ok(await wizardToStep3(page), nm + ': reaches step 3 again');
    await submit(page);
    const row2 = await quoteRow(page);
    ok(!!row2, nm + ': a quotes row is written');
    const d = row2 ? decl(row2) : null;
    ok(!!d && FIVE.every((k) => d[k] && typeof d[k].state === 'string'), nm + ': scope_summary.declarations carries all five rows ' + JSON.stringify(d && Object.keys(d)));
    ok(!!row2 && row2.trade_type === 'roofing', nm + ': trade_type is roofing (queue has roofing), got ' + (row2 && row2.trade_type));
    await context.close();
  }
  // 2. Wizard WITHOUT roofing (gutters + siding claim): no declarations required; trade_type is the first queued trade, not the
  //    hidden default "roofing" (main tagged this bid roofing).
  {
    const name = 'wizard gutters+siding (no roofing in the queue)';
    console.log('--- ' + name);
    const { context, page, dialogs } = await open(browser, base, ['gutters', 'siding']);
    ok(await page.evaluate(vis('#wizardStep1Card')), name + ': opens the wizard at step 1');
    await page.click('#wizardStep1Next'); await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      const l = await page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || '');
      if (l === 'GUTTERS') await fillIf(page, '#gutter6InchPrice', '2400');
      if (l === 'SIDING') { await fillIf(page, '#sidingInstallPerSquare', '300'); await fillIf(page, '#sidingTrimPrice', '1000'); }
      await page.evaluate(() => wizardNext()); await page.waitForTimeout(250);
      if (await page.evaluate(() => wizardStep === 3)) break;
    }
    ok(await page.evaluate(() => wizardStep === 3), name + ': reaches step 3');
    await submit(page);
    if (process.env.DBG) console.log('   dialogs', JSON.stringify(dialogs));
    const row = await quoteRow(page);
    ok(!!row, name + ': a quotes row is written with no Section 2 declarations (alerts: ' + JSON.stringify(dialogs) + ')');
    ok(!!row && decl(row) === null, name + ': no declarations key (Section 2 not required without roofing)');
    ok(!!row && row.trade_type === 'gutters', name + ': trade_type is gutters, NOT the hidden default roofing (got ' + (row && row.trade_type) + ')');
    await context.close();
  }
  // 2b. The hidden input's default must never decide trade_type in a wizard: force a gutters-only queue under the default.
  {
    const name = 'wizard queue [gutters] under the hidden default "roofing"';
    console.log('--- ' + name);
    const { context, page } = await open(browser, base, ['gutters', 'siding']);
    const got = await page.evaluate(() => {
      wizardTradeQueue = ['gutters'];
      document.getElementById('selectedTradeType').value = 'roofing';
      if (typeof _syncWizardTradeType !== 'function') return 'missing';
      _syncWizardTradeType();
      return document.getElementById('selectedTradeType').value;
    });
    ok(got === 'gutters', name + ': trade_type becomes gutters (got ' + got + ')');
    const got2 = await page.evaluate(() => { wizardTradeQueue = ['gutters', 'roofing']; _syncWizardTradeType(); return document.getElementById('selectedTradeType').value; });
    ok(got2 === 'roofing', name + ': a queue holding roofing tags roofing (got ' + got2 + ')');
    await context.close();
  }
  // 3. Single-trade retail roofing (no wizard): unchanged. Untouched refused, declared written.
  {
    const name = 'single-trade retail roofing (no wizard)';
    console.log('--- ' + name);
    const { context, page } = await open(browser, base, ['roofing']);
    ok(await page.evaluate(() => wizardMode === false), name + ': no wizard');
    ok(await page.evaluate(vis('#valueAddsSection')), name + ': Section 2 is on screen');
    await fillRoofingStep(page);
    await submit(page);
    ok(!(await quoteRow(page)), name + ': untouched Section 2 is refused, no row');
    await declareAll(page);
    await submit(page);
    const row = await quoteRow(page);
    ok(!!row, name + ': declared -> a quotes row is written');
    const d = row ? decl(row) : null;
    ok(!!d && FIVE.every((k) => d[k]), name + ': five declarations written ' + JSON.stringify(d && Object.keys(d)));
    ok(!!row && row.trade_type === 'roofing', name + ': trade_type roofing');
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? '\n' + fail + ' assertion(s) FAILED' : '\nall assertions passed');
process.exit(fail ? 1 : 0);
