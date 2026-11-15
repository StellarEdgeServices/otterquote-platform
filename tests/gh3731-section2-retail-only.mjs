/**
 * gh-3731 -- REAL headless-Chromium proof that contractor-bid-form.html requires the five Section 2 declarations ONLY on retail/cash
 * roofing bids (CTO ruling on #1339 comment 6776723904; #3711 trigger scope), and not on insurance bids.
 *
 * Before (head bb6da33b of PR #3727): an insurance single-trade bid is blocked because _section2Required() returns "the section is
 * on screen" and the form shows the section for insurance jobs. After: _section2Required() also needs isRetailJob (the form's own
 * retail/cash test: job_type 'retail' or funding_type 'cash', the same one #3711 keys on).
 *
 * Same harness as tests/gh1339-wizard-section2-declarations.mjs (real page over local HTTP, non-local requests aborted, stub Supabase
 * client). The real validateValueAddDeclarations() is not stubbed.
 *
 * Run: (cd tests/e2e && npm ci) && node tests/gh3731-section2-retail-only.mjs      Exit 0 = all green.
 * Negative control: ROOT=<checkout of PR #3727 head bb6da33b> node tests/gh3731-section2-retail-only.mjs  (expected exit 1)
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

function rows(trades, insurance) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: trades.includes('siding') ? '2026-01-01T00:00:00Z' : null, job_type: insurance ? 'insurance_rcv' : 'retail', funding_type: insurance ? 'insurance' : 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true, rcv_amount: insurance ? 15800 : null },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades, service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false }
  };
}
const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; let n = e; while (n) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement; } return e.getBoundingClientRect().width > 0; })()`;

async function open(browser, base, trades, insurance) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(trades, insurance));
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
const fillInsurance = async (page) => {
  await fillIf(page, '#totalPrice', '15800');
  await fillIf(page, '#brandProduct', 'GAF Timberline HDZ');
  await fillIf(page, '#startDate', new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  await selectIf(page, '#completionTime', '1-2 days');
  await selectIf(page, '#numStories', '1');
};
try {
  // 1. Insurance, single trade (roofing). Section 2 is on screen but NOT required: submit without declarations writes a row, no
  //    declarations key. (On PR #3727's head this is blocked.)
  {
    const name = 'insurance single-trade roofing, Section 2 untouched';
    console.log('--- ' + name);
    const { context, page, dialogs } = await open(browser, base, ['roofing'], true);
    ok(await page.evaluate(() => wizardMode === false && isRetailJob === false), name + ': no wizard, not a retail job');
    ok(await page.evaluate(() => _section2Required() === false), name + ': _section2Required() is false');
    await fillInsurance(page);
    await submit(page);
    const row = await quoteRow(page);
    ok(!!row, name + ': a quotes row is written without declarations (alerts: ' + JSON.stringify(dialogs) + ')');
    ok(!!row && decl(row) === null, name + ': no declarations key on the insurance bid');
    ok(!(await page.evaluate(vis('#gutterOptionRowError'))), name + ': no Section 2 row message is shown');
    await context.close();
  }
  // 1b. Insurance, a row the contractor DOES declare is recorded (REVIEW 6898935932): drip edge "Out of pocket $350" and gutters
  //     5" included are written to scope_summary.declarations; blank rows stay absent. (Fails at 4af9fb35.)
  {
    const name = 'insurance single-trade roofing, declared extra';
    console.log('--- ' + name);
    const { context, page, dialogs } = await open(browser, base, ['roofing'], true);
    await fillInsurance(page);
    await page.evaluate(() => {
      document.querySelector('input[type="radio"][name="dripEdgeOption"][value="oop"]').click();
      document.getElementById('dripEdgeOopPrice').value = '350';
      document.querySelector('input[type="radio"][name="gutterOption"][value="5inch_included"]').click();
    });
    await submit(page);
    const row = await quoteRow(page);
    ok(!!row, name + ': a quotes row is written (alerts: ' + JSON.stringify(dialogs) + ')');
    const d = row ? decl(row) : null;
    ok(!!d && d.drip_edge && d.drip_edge.state === 'extra' && d.drip_edge.rate_cents === 35000, name + ': drip_edge extra 35000 cents is recorded ' + JSON.stringify(d));
    ok(!!d && d.gutters && d.gutters.state === 'included', name + ': gutters included is recorded');
    ok(!!d && !d.skylights && !d.ice_water_shield, name + ': blank rows stay absent');
    await context.close();
    // an extra with no rate is still refused on insurance
    const c2 = await open(browser, base, ['roofing'], true);
    await fillInsurance(c2.page);
    await c2.page.evaluate(() => { document.querySelector('input[type="radio"][name="dripEdgeOption"][value="oop"]').click(); });
    await submit(c2.page);
    ok(!(await quoteRow(c2.page)), name + ': a declared extra with no rate is refused');
    ok(await c2.page.evaluate(vis('#dripEdgeOptionRowError')), name + ': the rate message is shown');
    await c2.context.close();
  }
  // 2. Retail roofing, single trade: still blocked without declarations, written with them.
  {
    const name = 'retail single-trade roofing';
    console.log('--- ' + name);
    const { context, page } = await open(browser, base, ['roofing'], false);
    ok(await page.evaluate(() => wizardMode === false && isRetailJob === true), name + ': no wizard, retail job');
    ok(await page.evaluate(() => _section2Required() === true), name + ': _section2Required() is true');
    await fillRoofingStep(page);
    await submit(page);
    ok(!(await quoteRow(page)), name + ': untouched Section 2 is refused, no row');
    ok(await page.evaluate(vis('#gutterOptionRowError')), name + ': per-row message is visible');
    await declareAll(page);
    await submit(page);
    const row = await quoteRow(page);
    ok(!!row, name + ': declared -> a quotes row is written');
    const d = row ? decl(row) : null;
    ok(!!d && FIVE.every((k) => d[k]), name + ': five declarations written');
    await context.close();
  }
  // 3. Insurance multi-trade (roofing + gutters): unaffected, same as before. Whatever path the form takes (wizard or not), no
  //    declarations are required and none are written.
  {
    const name = 'insurance multi-trade (roofing+gutters)';
    console.log('--- ' + name);
    const { context, page, dialogs } = await open(browser, base, ['roofing', 'gutters'], true);
    const wiz = await page.evaluate(() => wizardMode);
    console.log('   (wizardMode on an insurance multi-trade claim: ' + wiz + ')');
    ok(await page.evaluate(() => _section2Required() === false), name + ': _section2Required() is false');
    if (wiz) {
      await page.click('#wizardStep1Next'); await page.waitForTimeout(300);
      for (let i = 0; i < 4; i++) {
        const l = await page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || '');
        if (l === 'ROOFING') await fillRoofingStep(page);
        if (l === 'GUTTERS') await fillIf(page, '#gutter6InchPrice', '2400');
        await page.evaluate(() => wizardNext()); await page.waitForTimeout(250);
        if (await page.evaluate(() => wizardStep === 3)) break;
      }
    } else {
      await fillInsurance(page);
    }
    await submit(page);
    const row = await quoteRow(page);
    ok(!!row, name + ': a quotes row is written (alerts: ' + JSON.stringify(dialogs) + ')');
    ok(!!row && decl(row) === null, name + ': no declarations key');
    await context.close();
  }
  // 4. Retail wizard (roofing+gutters) is the #3727 behaviour and must not change: still required.
  {
    const name = 'retail wizard roofing+gutters (#3727 behaviour)';
    console.log('--- ' + name);
    const { context, page } = await open(browser, base, ['roofing', 'gutters'], false);
    ok(await page.evaluate(() => wizardMode === true && _section2Required() === true), name + ': wizard, Section 2 required');
    await page.click('#wizardStep1Next'); await page.waitForTimeout(300);
    await fillRoofingStep(page);
    await page.evaluate(() => wizardNext()); await page.waitForTimeout(250);
    await fillIf(page, '#gutter6InchPrice', '2400');
    ok(await wizardToStep3(page), name + ': reaches step 3');
    await submit(page);
    ok(!(await quoteRow(page)), name + ': no row without declarations');
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? '\n' + fail + ' assertion(s) FAILED' : '\nall assertions passed');
process.exit(fail ? 1 : 0);
