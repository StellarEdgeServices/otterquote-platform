/**
 * gh-3569 -- REAL headless-Chromium proof that the static D-162 multi-trade wizard on contractor-bid-form.html lets a
 * contractor SEE, ENTER and EDIT a roofing price on the roofing step, and that a NEW retail roofing + gutters bid then
 * submits (writes a quotes row) with the stored fee equal to the fee shown on the page.
 *
 * gh-3495 (Ben's ruling 6727931801, D-267): a multi-trade bid's total is the SUM of its trades and the fee is computed on
 * that total. So roofing 15800 + gutters 2400 stores total_price 18200 / fee 910 (it stored the roofing price alone,
 * 15800 / 790, before #3561). Siding cannot be priced on the wizard siding step in a roofing combo (#3561 REVIEW N1,
 * tracked separately), so it adds nothing here unless its field is visible.
 *
 * Cause: _showWizardTrade() hid #retailPriceSection on the roofing step (the comment claimed a "total price input" in
 * valueAddsSection, which does not exist). #retailBidPrice is the only roofing price input, and the retail submit check
 * requires it > 0, so every new wizard bid that included roofing stopped at "Please enter your total bid price."
 *
 * Same harness as tests/gh3496-retail-change-bid-price.mjs: the real page is served from this repo over local HTTP; every
 * non-local request is aborted; the Supabase CDN script is replaced by a stub client (no network, no real Supabase);
 * Auth.requireAuth is stubbed. Roofing-step fields are filled through the real UI. The value-add declaration gate, the
 * D-199 template gate and the required attributes on non-price fields outside the roofing step are cleared by script so
 * the price path is what is under test.
 *
 * Run: (cd tests/e2e && npm ci) && node tests/gh3569-wizard-roofing-price-field.mjs      Exit 0 = all green.
 * Negative control: ROOT=<checkout of main before this change> node tests/gh3569-wizard-roofing-price-field.mjs  (expected exit 1)
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


const ROOF_FIRST = 14250;
const ROOF_EDITED = 15800;
const GUTTER_PRICE = 2400;

function rows(trades, sidingReleased) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: sidingReleased ? '2026-01-01T00:00:00Z' : null, job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades, service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false }
    // no quotes row: this is a NEW bid
  };
}

const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; let n = e; while (n) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement; } return e.getBoundingClientRect().width > 0; })()`;
const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(v);

// One NEW wizard bid through the real page.
//   trades          the claim's trades (roofing first in the wizard queue)
//   zeroBaseAtSubmit  REVIEW 6742800394 guard: blank the trade prices themselves (the inputs, the captured per-trade
//                   prices and #totalPrice) right before submit; the sum is then 0, so the submit must refuse with the
//                   price alert and write no quotes row.
async function scenario(browser, base, { trades, zeroBaseAtSubmit = false }) {
  const name = trades.join(' + ') + (zeroBaseAtSubmit ? ' (fee base zeroed at submit)' : '');
  console.log('--- ' + name);
  const hasSiding = trades.includes('siding');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(trades, hasSiding));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  if (process.env.DBG) { page.on('console', (m) => console.log('   [console]', m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 200))); }
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1', { waitUntil: 'load' });
  await page.waitForFunction(() => { const c = document.getElementById('wizardStep1Card'); return c && getComputedStyle(c).display !== 'none'; }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  ok(await page.evaluate(vis('#wizardStep1Card')), name + ': new retail bid opens the D-162 wizard at step 1');

  // Step 1 -> step 2 (roofing)
  await page.click('#wizardStep1Next');
  await page.waitForTimeout(300);
  const label = await page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || '');
  ok(label === 'ROOFING', name + ': wizard step 2 is on the roofing trade (label ' + JSON.stringify(label) + ')');

  // The acceptance test: the roofing price field is visible and can be typed into and edited.
  ok(await page.evaluate(vis('#retailBidPrice')), name + ': roofing step: the roofing price field (#retailBidPrice) is visible');
  let typed = false, edited = false;
  try {
    await page.fill('#retailBidPrice', String(ROOF_FIRST), { timeout: 2000 });
    typed = (await page.inputValue('#retailBidPrice')) === String(ROOF_FIRST);
    await page.fill('#retailBidPrice', String(ROOF_EDITED), { timeout: 2000 });
    edited = (await page.inputValue('#retailBidPrice')) === String(ROOF_EDITED);
  } catch (e) { console.log('     fill failed: ' + e.message.split('\n')[0]); }
  ok(typed, name + ': roofing step: the contractor can type a roofing price');
  ok(edited, name + ': roofing step: the contractor can edit the roofing price');
  const shownBid = await page.evaluate(() => document.getElementById('displayBid').textContent);
  ok(edited && shownBid === '$15,800.00', name + ': fee calculator shows the edited roofing price as the bid (' + shownBid + ')');

  // Other roofing-step required fields, through the UI.
  const fillIf = async (sel, v) => { if (await page.evaluate(vis(sel))) await page.fill(sel, v); };
  const selectIf = async (sel, v) => { if (await page.evaluate(vis(sel))) await page.selectOption(sel, v); };
  await fillIf('#brandProduct', 'GAF Timberline HDZ');
  await fillIf('#startDate', new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  await selectIf('#completionTime', '1-2 days');
  await selectIf('#numStories', '1');
  await fillIf('#deckingPricePerSheet', '85');
  await fillIf('#fullRedeckPrice', '4200');

  // The remaining trades, in wizard order, until step 3.
  const seen = [];
  let expectTotal = ROOF_EDITED; // gh-3495: the sum of the trades priced below
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => wizardNext());
    await page.waitForTimeout(300);
    const onStep3 = await page.evaluate(() => wizardStep === 3);
    if (onStep3) break;
    const l = await page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || '');
    seen.push(l);
    ok(!(await page.evaluate(vis('#retailBidPrice'))), name + ': ' + l.toLowerCase() + ' step: the roofing price field is not shown');
    if (l === 'GUTTERS' && await page.evaluate(vis('#gutter6InchPrice'))) { await page.fill('#gutter6InchPrice', String(GUTTER_PRICE)); expectTotal += GUTTER_PRICE; }
    if (l === 'SIDING' && await page.evaluate(vis('#sidingInstallPerSquare'))) {
      await page.fill('#sidingInstallPerSquare', '300'); await fillIf('#sidingTrimPrice', '1000');
      expectTotal += await page.evaluate(() => _sidingTotalNow());
    }
  }
  const expectFee = Math.round(expectTotal * 5) / 100; // whole cents at the 5% rate the stub serves
  const expectSeen = trades.filter((t) => t !== 'roofing').map((t) => t.toUpperCase());
  ok(JSON.stringify(seen.slice().sort()) === JSON.stringify(expectSeen.slice().sort()), name + ': wizard visits the other trades ' + JSON.stringify(seen));

  const summary = await page.evaluate(() => document.getElementById('wizardTradeSummaryRows')?.textContent.replace(/\s+/g, ' ').trim());
  console.log('     step-3 summary: ' + summary);
  ok(/Roofing\s*\$15,800\.00/.test(summary || ''), name + ': step 3 summary carries the edited roofing price');

  // Leaving the siding step must not have clobbered the fee base (REVIEW 6742800394 finding 1); the base is the sum.
  const shownFee = await page.evaluate(() => document.getElementById('totalFeeAmount').textContent);
  const shownBid3 = await page.evaluate(() => document.getElementById('displayBid').textContent);
  console.log('     bid / fee shown at submit: ' + shownBid3 + ' / ' + shownFee);
  if (!zeroBaseAtSubmit) {
    ok(shownBid3 === fmt(expectTotal) && shownFee === fmt(expectFee), name + ': fee box at step 3 shows the sum of the trades and its fee, ' + fmt(expectTotal) + ' / ' + fmt(expectFee) + ' (' + shownBid3 + ' / ' + shownFee + ')');
  }

  await page.evaluate((zero) => {
    document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
    window.validateValueAddDeclarations = () => true;
    window.checkBidCanSubmitGate = async () => ({ can_submit: true });
    if (zero) {
      ['retailBidPrice', 'gutter5InchPrice', 'gutter6InchPrice', 'sidingInstallPerSquare', 'sidingTrimPrice', 'totalPrice'].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ''; });
      wizardTradePrices = {};
      updateFeeCalculator();
    }
  }, zeroBaseAtSubmit);
  await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(1500);
  const allWrites = await page.evaluate(() => window.__writes);
  if (process.env.DBG) console.log('   [writes]', JSON.stringify(allWrites).slice(0, 600));
  const q = allWrites.filter((w) => w.table === 'quotes' && (w.method === 'insert' || w.method === 'upsert'));
  const row = q.length ? (Array.isArray(q[0].payload) ? q[0].payload[0] : q[0].payload) : null;
  const rowTxt = row ? 'total_price=' + row.total_price + ', fee_amount=' + row.fee_amount : 'none';
  if (zeroBaseAtSubmit) {
    ok(dialogs.includes(NEEDLE), name + ': a zero total is refused with "' + NEEDLE + '" (alerts seen: ' + JSON.stringify(dialogs) + ')');
    ok(!row, name + ': no quotes row is written for a zero total (' + rowTxt + ')');
  } else {
    ok(!dialogs.includes(NEEDLE), name + ': submit is not stopped at "' + NEEDLE + '" (alerts seen: ' + JSON.stringify(dialogs) + ')');
    ok(!!row, name + ': submit writes a new quotes row (' + rowTxt + ')');
    ok(!!row && row.total_price > 0 && row.fee_amount > 0, name + ': stored total_price and fee_amount are nonzero (' + rowTxt + ')');
    ok(!!row && row.total_price === expectTotal && row.fee_amount === expectFee, name + ': stored total_price / fee are the sum of the trades and its fee, ' + expectTotal + ' / ' + expectFee + ' (' + rowTxt + ')');
    ok(!!row && fmt(row.fee_amount) === shownFee, name + ': stored fee_amount equals the fee shown (' + (row ? fmt(row.fee_amount) : 'n/a') + ' vs ' + shownFee + ')');
  }
  await context.close();
}

// REVIEW 6743095024: enter a roofing price, go Back, UNCHECK roofing, price the other trade, submit. The roofing price
// typed earlier must not become the fee base or the stored total. Main stops this flow at the price alert with no row
// (there the roofing price cannot be entered at all), so the expected outcome is exactly main's.
async function staleRoofingScenario(browser, base, { trades }) {
  const other = trades.filter((t) => t !== 'roofing');
  const name = trades.join(' + ') + ' claim: roofing price entered, Back, roofing unchecked';
  console.log('--- ' + name);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(trades, trades.includes('siding')));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1', { waitUntil: 'load' });
  await page.waitForFunction(() => { const c = document.getElementById('wizardStep1Card'); return c && getComputedStyle(c).display !== 'none'; }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const fillIf = async (sel, v) => { if (await page.evaluate(vis(sel))) await page.fill(sel, v); };

  await page.click('#wizardStep1Next');
  await page.waitForTimeout(300);
  let typed = false;
  try { await page.fill('#retailBidPrice', String(ROOF_EDITED), { timeout: 2000 }); typed = true; } catch (e) { console.log('     fill failed: ' + e.message.split('\n')[0]); }
  ok(typed, name + ': roofing price typed on the roofing step');
  await page.evaluate(() => wizardBack());
  await page.waitForTimeout(300);
  await page.uncheck('#wizardTradeCheckboxes input[value="roofing"]');
  await page.click('#wizardStep1Next');
  await page.waitForTimeout(300);
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate(() => wizardStep === 3)) break;
    const l = await page.evaluate(() => document.getElementById('wizardTradeLabel')?.textContent || '');
    if (l === 'GUTTERS') await fillIf('#gutter6InchPrice', String(GUTTER_PRICE));
    if (l === 'SIDING') { await fillIf('#sidingInstallPerSquare', '300'); await fillIf('#sidingTrimPrice', '1000'); }
    await page.evaluate(() => wizardNext());
    await page.waitForTimeout(300);
  }
  const queue = await page.evaluate(() => wizardTradeQueue.join(','));
  ok(queue === other.join(','), name + ': wizard queue is ' + JSON.stringify(queue));
  const summary = await page.evaluate(() => document.getElementById('wizardTradeSummaryRows')?.textContent.replace(/\s+/g, ' ').trim());
  console.log('     step-3 summary: ' + summary);
  ok(!/Roofing/.test(summary || ''), name + ': step 3 summary has no roofing row');
  const st = await page.evaluate(() => ({ bid: document.getElementById('displayBid').textContent, fee: document.getElementById('totalFeeAmount').textContent, base: document.getElementById('totalPrice').value, roof: document.getElementById('retailBidPrice').value }));
  console.log('     bid / fee shown at submit: ' + st.bid + ' / ' + st.fee + '  #totalPrice=' + JSON.stringify(st.base));
  ok(st.base === '' && st.roof === '', name + ': the stale roofing price is cleared from #retailBidPrice and #totalPrice (' + JSON.stringify(st) + ')');
  // gh-3495: the fee box shows the sum of the trades still on the bid (the gutters price, if priced), never the roofing price.
  const left = await page.evaluate(() => document.getElementById('wizardGrandTotal')?.textContent || '$0.00');
  ok(st.bid !== fmt(ROOF_EDITED) && st.bid === (left === '' ? '$0.00' : left), name + ': fee box no longer shows the removed roofing price; it shows the remaining trades (' + st.bid + ' / ' + st.fee + ', Grand Total ' + left + ')');

  await page.evaluate(() => {
    document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
    window.validateValueAddDeclarations = () => true;
    window.checkBidCanSubmitGate = async () => ({ can_submit: true });
  });
  await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(1500);
  const allWrites = await page.evaluate(() => window.__writes);
  const q = allWrites.filter((w) => w.table === 'quotes' && (w.method === 'insert' || w.method === 'upsert'));
  const row = q.length ? (Array.isArray(q[0].payload) ? q[0].payload[0] : q[0].payload) : null;
  const rowTxt = row ? 'total_price=' + row.total_price + ', fee_amount=' + row.fee_amount + ', trade_type=' + row.trade_type + ', per_trade_breakdown=' + JSON.stringify(row.per_trade_breakdown) : 'none';
  ok(dialogs.includes(NEEDLE), name + ': submit stops at "' + NEEDLE + '", as on main (alerts seen: ' + JSON.stringify(dialogs) + ')');
  ok(!row, name + ': no quotes row is written at the removed roofing price (' + rowTxt + ')');
  await context.close();
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  await scenario(browser, base, { trades: ['roofing', 'gutters'] });
  await scenario(browser, base, { trades: ['roofing', 'siding'] });
  await scenario(browser, base, { trades: ['roofing', 'gutters', 'siding'] });
  await scenario(browser, base, { trades: ['roofing', 'gutters'], zeroBaseAtSubmit: true });
  await staleRoofingScenario(browser, base, { trades: ['roofing', 'gutters'] });
  await staleRoofingScenario(browser, base, { trades: ['roofing', 'siding'] });
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
