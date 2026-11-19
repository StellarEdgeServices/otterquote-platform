/**
 * gh-3576 -- REAL headless-Chromium proof that the static D-162 multi-trade wizard on contractor-bid-form.html saves the
 * trade price when the contractor uses the BROWSER Back/Forward buttons, not only the wizard's own Next button.
 *
 * Cause: the popstate handler switched steps with wizardGoTo() and never called captureCurrentTradePrice(), so a price
 * edited after browser Back stayed out of wizardTradePrices. The step-3 summary and the stored per_trade_breakdown (which
 * the homeowner sees) then showed the old price next to a bid stored at the new one. History navigation also ignored the
 * step-1 checkboxes, and a wizard queue restored from localStorage was not checked against the claim's current trades.
 *
 * Scenarios (each fails on the code before this change, 09a9f111):
 *   A  R+G: price roofing 15800, reach step 3, browser Back x2, edit roofing to 17000, browser Forward x2, submit.
 *      Summary, per_trade_breakdown and stored total all carry 17000; stored fee = fee shown.
 *   B  R+G gutters twin: reach step 3, browser Back, edit gutters 2400 -> 3000, browser Forward, submit.
 *   C  G+S claim, siding unchecked: the gutters-only twin of A (summary and saved trade price).
 *   D  R+G: reach step 3, browser Back to step 1, uncheck roofing, browser Forward: the queue is rebuilt without
 *      roofing and no row is written at the removed roofing price.
 *   E  R+G: wizard saved at the roofing step, reload after the claim's trades change to G+S: the restored queue drops
 *      roofing.
 *
 * Same harness as tests/gh3569-wizard-roofing-price-field.mjs (real page over local HTTP, stub Supabase client, no network).
 *
 * Run: (cd tests/e2e && npm ci) && node tests/gh3576-wizard-popstate-price.mjs      Exit 0 = all green.
 * Negative control: ROOT=<checkout of 09a9f111> node tests/gh3576-wizard-popstate-price.mjs  (expected exit 1)
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
    rpc: function (name) { if (name === 'quotes_platform_fee_for') return Promise.resolve({ data: [{ fee_pct: 5, fee_basis: 'bid_amount' }], error: null }); return Promise.resolve({ data: null, error: null }); }, // gh-3497: the rate is read through this rpc (platform_fee_config is admin-only under RLS)
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



const ROOF = 15800, ROOF_EDIT = 17000, GUT = 2400, GUT_EDIT = 3000;

function rows(trades, sidingReleased) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: sidingReleased ? '2026-01-01T00:00:00Z' : null, job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades: ['roofing', 'gutters', 'siding'], service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false }
  };
}

const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; let n = e; while (n) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement; } return e.getBoundingClientRect().width > 0; })()`;
const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(v);

async function open(browser, base, trades) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  // localStorage is cleared once per context; a sessionStorage override changes the claim's trades on a later reload.
  await page.addInitScript((r) => {
    try {
      if (!sessionStorage.getItem('__init')) { localStorage.clear(); sessionStorage.setItem('__init', '1'); }
      const o = sessionStorage.getItem('__trades');
      if (o) { r = JSON.parse(JSON.stringify(r)); r.bidder_claim_summary.trades = JSON.parse(o); }
    } catch (e) {}
    window.__ROWS = r;
  }, rows(trades, true));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1', { waitUntil: 'load' });
  await waitWizard(page);
  const h = {
    page, dialogs, errors, context,
    fillIf: async (sel, v) => { if (await page.evaluate(vis(sel))) { await page.fill(sel, v); return true; } return false; },
    label: () => page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || ''),
    step: () => page.evaluate(() => wizardStep),
    queue: () => page.evaluate(() => wizardTradeQueue.join(',')),
    next: async () => { await page.click(await page.evaluate(() => wizardStep === 1) ? '#wizardStep1Next' : '#wizardStep2Next'); await page.waitForTimeout(300); },
    histBack: async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(350); },
    histFwd: async () => { await page.evaluate(() => history.forward()); await page.waitForTimeout(350); },
    summary: () => page.evaluate(() => (document.getElementById('wizardTradeSummaryRows')?.textContent || '').replace(/\s+/g, ' ').trim()),
    grand: () => page.evaluate(() => document.getElementById('wizardGrandTotal')?.textContent || ''),
    shown: () => page.evaluate(() => ({ bid: document.getElementById('displayBid').textContent, fee: document.getElementById('totalFeeAmount').textContent })),
  };
  h.fillRoofing = async (price) => {
    const typed = await h.fillIf('#retailBidPrice', String(price));
    await h.fillIf('#brandProduct', 'GAF Timberline HDZ');
    await h.fillIf('#startDate', new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
    if (await page.evaluate(vis('#completionTime'))) await page.selectOption('#completionTime', '1-2 days');
    if (await page.evaluate(vis('#numStories'))) await page.selectOption('#numStories', '1');
    await h.fillIf('#deckingPricePerSheet', '85');
    await h.fillIf('#fullRedeckPrice', '4200');
    return typed;
  };
  h.submit = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
      window.validateValueAddDeclarations = () => true;
      window.checkBidCanSubmitGate = async () => ({ can_submit: true });
    });
    await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
    await page.waitForTimeout(1500);
    const w = await page.evaluate(() => window.__writes);
    const q = w.filter((x) => x.table === 'quotes' && (x.method === 'insert' || x.method === 'upsert'));
    return q.length ? (Array.isArray(q[0].payload) ? q[0].payload[0] : q[0].payload) : null;
  };
  return h;
}

async function waitWizard(page) {
  await page.waitForFunction(() => { const c = document.getElementById('wizardProgressBar'); return c && getComputedStyle(c).display !== 'none'; }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}

const rowTxt = (row) => row ? `total_price=${row.total_price}, fee_amount=${row.fee_amount}, trade_type=${row.trade_type}, per_trade_breakdown=${JSON.stringify(row.per_trade_breakdown)}` : 'none';

// R+G, both trades priced, ending on step 3.
async function toStep3RG(h) {
  await h.next();
  ok(await h.label() === 'ROOFING', 'setup: wizard step 2 starts on roofing');
  ok(await h.fillRoofing(ROOF), 'setup: roofing price typed');
  await h.next();
  ok(await h.label() === 'GUTTERS', 'setup: wizard moves to gutters');
  await h.fillIf('#gutter6InchPrice', String(GUT));
  await h.next();
  ok(await h.step() === 3, 'setup: wizard reaches step 3');
}

async function scenarioA(browser, base) {
  const n = 'A R+G roofing edited via browser Back/Forward';
  console.log('--- ' + n);
  const h = await open(browser, base, ['roofing', 'gutters']);
  await toStep3RG(h);
  await h.histBack(); await h.histBack();
  ok(await h.step() === 2 && await h.label() === 'ROOFING', n + ': browser Back x2 lands on the roofing step');
  await h.page.fill('#retailBidPrice', String(ROOF_EDIT));
  await h.histFwd(); await h.histFwd();
  ok(await h.step() === 3, n + ': browser Forward x2 returns to step 3');
  const s = await h.summary(), g = await h.grand();
  console.log('     step-3 summary: ' + s + ' | grand ' + g);
  ok(/Roofing\s*\$17,000\.00/.test(s), n + ': step-3 summary shows the edited roofing price $17,000.00');
  ok(!/\$15,800\.00/.test(s), n + ': step-3 summary no longer shows the old roofing price $15,800.00');
  ok(g === '$19,400.00', n + ': summary grand total uses the edited price (' + g + ')');
  const shown = await h.shown();
  // #3561 (D-267): the fee box and stored total are the SUM of the trades (17000 + 2400 = 19400, 5% = $970), not roofing alone.
  ok(shown.bid === '$19,400.00' && shown.fee === '$970.00', n + ': fee box shows the sum of trades $19,400.00 / $970.00 (' + shown.bid + ' / ' + shown.fee + ')');
  const row = await h.submit();
  console.log('     quotes row: ' + rowTxt(row));
  ok(!!row, n + ': submit writes a quotes row (alerts ' + JSON.stringify(h.dialogs) + ')');
  ok(!!row && row.per_trade_breakdown && row.per_trade_breakdown.roofing === ROOF_EDIT, n + ': per_trade_breakdown.roofing is the edited 17000');
  ok(!!row && row.per_trade_breakdown && row.per_trade_breakdown.gutters === GUT, n + ': per_trade_breakdown.gutters is 2400');
  ok(!!row && row.total_price === ROOF_EDIT + GUT, n + ': stored total_price is the sum of trades with the edited roofing, 19400');
  ok(!!row && fmt(row.fee_amount) === shown.fee, n + ': stored fee_amount equals the fee shown (' + (row ? fmt(row.fee_amount) : 'n/a') + ' vs ' + shown.fee + ')');
  ok(h.errors.length === 0, n + ': no page errors ' + JSON.stringify(h.errors));
  await h.context.close();
}

async function scenarioB(browser, base) {
  const n = 'B R+G gutters edited via browser Back/Forward';
  console.log('--- ' + n);
  const h = await open(browser, base, ['roofing', 'gutters']);
  await toStep3RG(h);
  await h.histBack();
  ok(await h.step() === 2 && await h.label() === 'GUTTERS', n + ': browser Back lands on the gutters step');
  await h.page.fill('#gutter6InchPrice', String(GUT_EDIT));
  await h.histFwd();
  ok(await h.step() === 3, n + ': browser Forward returns to step 3');
  const s = await h.summary();
  console.log('     step-3 summary: ' + s);
  ok(/Gutters\s*\$3,000\.00/.test(s), n + ': step-3 summary shows the edited gutters price $3,000.00');
  ok(/Roofing\s*\$15,800\.00/.test(s), n + ': step-3 summary keeps roofing at $15,800.00');
  const shown = await h.shown();
  const row = await h.submit();
  console.log('     quotes row: ' + rowTxt(row));
  ok(!!row, n + ': submit writes a quotes row (alerts ' + JSON.stringify(h.dialogs) + ')');
  ok(!!row && row.per_trade_breakdown && row.per_trade_breakdown.gutters === GUT_EDIT, n + ': per_trade_breakdown.gutters is the edited 3000');
  ok(!!row && row.per_trade_breakdown && row.per_trade_breakdown.roofing === ROOF, n + ': per_trade_breakdown.roofing is 15800');
  ok(!!row && row.total_price === ROOF + GUT_EDIT && fmt(row.fee_amount) === shown.fee, n + ': stored total (sum of trades, 18800) and fee match the fee box (' + rowTxt(row) + ' vs ' + shown.bid + ' / ' + shown.fee + ')');
  ok(h.errors.length === 0, n + ': no page errors ' + JSON.stringify(h.errors));
  await h.context.close();
}

async function scenarioC(browser, base) {
  const n = 'C G+S claim, gutters only, gutters edited via browser Back/Forward';
  console.log('--- ' + n);
  const h = await open(browser, base, ['gutters', 'siding']);
  await h.page.uncheck('#wizardTradeCheckboxes input[value="siding"]');
  await h.next();
  ok(await h.label() === 'GUTTERS', n + ': wizard step 2 is gutters');
  await h.fillIf('#gutter6InchPrice', String(GUT));
  await h.next();
  ok(await h.step() === 3, n + ': wizard reaches step 3');
  ok(/Gutters\s*\$2,400\.00/.test(await h.summary()), n + ': summary first shows $2,400.00');
  await h.histBack();
  ok(await h.step() === 2 && await h.label() === 'GUTTERS', n + ': browser Back lands on the gutters step');
  await h.page.fill('#gutter6InchPrice', String(GUT_EDIT));
  await h.histFwd();
  ok(await h.step() === 3, n + ': browser Forward returns to step 3');
  const s = await h.summary(), g = await h.grand();
  console.log('     step-3 summary: ' + s + ' | grand ' + g);
  ok(/Gutters\s*\$3,000\.00/.test(s) && g === '$3,000.00', n + ': summary and grand total show the edited gutters price $3,000.00');
  const saved = await h.page.evaluate(() => wizardTradePrices.gutters);
  ok(saved === GUT_EDIT, n + ': the saved gutters price (per_trade_breakdown source) is 3000 (' + saved + ')');
  ok(h.errors.length === 0, n + ': no page errors ' + JSON.stringify(h.errors));
  await h.context.close();
}

async function scenarioD(browser, base) {
  const n = 'D R+G browser Back to step 1, uncheck roofing, browser Forward';
  console.log('--- ' + n);
  const h = await open(browser, base, ['roofing', 'gutters']);
  await toStep3RG(h);
  await h.histBack(); await h.histBack(); await h.histBack();
  ok(await h.step() === 1, n + ': browser Back x3 lands on step 1');
  await h.page.uncheck('#wizardTradeCheckboxes input[value="roofing"]');
  await h.histFwd();
  const q = await h.queue();
  ok(q === 'gutters', n + ': browser Forward rebuilds the trade queue from the checkboxes (' + JSON.stringify(q) + ')');
  ok(await h.step() === 2 && await h.label() === 'GUTTERS', n + ': browser Forward lands on the gutters step, not the unchecked roofing step (' + await h.label() + ')');
  const st = await h.page.evaluate(() => ({ roof: document.getElementById('retailBidPrice').value, base: document.getElementById('totalPrice').value, wtp: wizardTradePrices.roofing }));
  ok(st.roof === '' && st.base === '' && st.wtp === undefined, n + ': the unchecked roofing price is cleared (' + JSON.stringify(st) + ')');
  await h.histFwd(); await h.histFwd();
  ok(await h.label() !== 'ROOFING', n + ': further browser Forward never returns to the roofing step');
  if (await h.step() !== 3) await h.next();
  ok(await h.step() === 3, n + ': wizard reaches step 3');
  const s = await h.summary();
  console.log('     step-3 summary: ' + s);
  ok(!/Roofing/.test(s), n + ': step-3 summary has no roofing row');
  const row = await h.submit();
  console.log('     quotes row: ' + rowTxt(row) + '  alerts ' + JSON.stringify(h.dialogs));
  ok(!row || (row.trade_type !== 'roofing' && row.total_price !== ROOF), n + ': no quotes row is written at the unchecked roofing price (' + rowTxt(row) + ')');
  ok(h.errors.length === 0, n + ': no page errors ' + JSON.stringify(h.errors));
  await h.context.close();
}

async function scenarioE(browser, base) {
  const n = 'E R+G saved at the roofing step, reload after claim trades change to G+S';
  console.log('--- ' + n);
  const h = await open(browser, base, ['roofing', 'gutters']);
  await h.next();
  await h.fillRoofing(ROOF);
  ok(await h.label() === 'ROOFING', n + ': wizard saved on the roofing step');
  await h.page.evaluate(() => sessionStorage.setItem('__trades', JSON.stringify(['gutters', 'siding'])));
  await h.page.reload({ waitUntil: 'load' });
  await waitWizard(h.page);
  const q = await h.queue();
  ok(!q.split(',').includes('roofing'), n + ': restored queue drops roofing, no longer on the claim (' + JSON.stringify(q) + ')');
  ok(await h.label() !== 'ROOFING', n + ': restored wizard does not open the roofing step (' + await h.label() + ')');
  const boxes = await h.page.evaluate(() => [...document.querySelectorAll('#wizardTradeCheckboxes input')].map((c) => c.value + ':' + c.checked).join(','));
  ok(!/roofing/.test(boxes), n + ': step-1 checkboxes list only the claim\'s trades (' + boxes + ')');
  ok(h.errors.length === 0, n + ': no page errors ' + JSON.stringify(h.errors));
  await h.context.close();
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  await scenarioA(browser, base);
  await scenarioB(browser, base);
  await scenarioC(browser, base);
  await scenarioD(browser, base);
  await scenarioE(browser, base);
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
