/**
 * gh-3495 (REVIEW 6744431358 F1) -- REAL headless-Chromium proof that a Change Bid and a Renew of a STORED multi-trade
 * (wizard) bid on contractor-bid-form.html keep every trade's stored price when the contractor clicks straight through.
 *
 * The stored quote is shaped like a real wizard bid: per_trade_breakdown is set and value_adds carries NO
 * gutter_5inch_price / gutter_6inch_price (the form writes those only for gutter-only claims). Before the fix the gutter
 * fields came up empty, the gutters step read them as 0 and Next replaced the loaded gutters price with null, so a Renew
 * of roofing + gutters stored at 18,200.13 wrote 15800 / 790 with per_trade_breakdown {roofing}.
 *
 * Each case asserts: no alert, a quotes write, total_price == the stored sum, per_trade_breakdown == the stored
 * breakdown, the Grand Total, fee box and fee disclosure at step 3 show that sum and its fee, and the stored fee
 * (rounded as the server rounds it) equals the fee shown. One case edits gutters to prove an edit still wins.
 *
 * Same harness as gh3496 (real page over local HTTP, stub Supabase client, no network, no secrets).
 * Run: (cd tests/e2e && npm ci && npx playwright install chromium) && node tests/gh3495-wizard-change-renew-chromium.mjs
 * Negative control: ROOT=<checkout at 26c11edc> node tests/gh3495-wizard-change-renew-chromium.mjs   (expected exit 1)
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
    var b = { _ins: false };
    ['select','eq','neq','in','is','not','order','limit','gt','gte','lt','lte','ilike','like','or','filter','match','range','contains','abortSignal'].forEach(function (m) { b[m] = function () { return b; }; });
    ['update','insert','upsert','delete'].forEach(function (m) { b[m] = function (payload) { b._ins = true; window.__writes.push({ table: table, method: m, payload: JSON.parse(JSON.stringify(payload)) }); return b; }; });
    var one = function () { if (b._ins) return Promise.resolve({ data: { id: 'new-' + table }, error: null }); var r = ROWS[table]; return Promise.resolve({ data: r === undefined ? null : r, error: r === undefined ? { message: 'none' } : null }); };
    b.single = one; b.maybeSingle = one;
    b.then = function (res, rej) { return Promise.resolve({ data: b._ins ? [{ id: 'new-' + table }] : [], error: null }).then(res, rej); };
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


const cents = (n) => Math.round(Number(n + 'e2'));
const money = (s) => Number(String(s || '').replace(/[$,]/g, ''));
function rows(trades, renew, breakdown, valueAdds) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  const total = Object.values(breakdown).reduce((a, v) => a + cents(v), 0) / 100;
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: '2026-01-02T00:00:00Z', job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades: ['roofing', 'gutters', 'siding'], service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false },
    quotes: { id: 'quote-1', claim_id: 'claim-1', contractor_id: 'contractor-1', status: 'submitted', bid_status: renew ? 'expired' : 'active', total_price: total, platform_fee_pct: 5, fee_percentage: 5, fee_amount: Math.round(total * 5) / 100, expires_at: new Date(Date.now() + (renew ? -1 : 10) * 864e5).toISOString(), scope_summary: '{}', value_adds: valueAdds, notes: '', auto_renew: true, per_trade_breakdown: breakdown },
  };
}

async function run(browser, base, c) {
  const label = (c.renew ? 'Renew ' : 'Change Bid ') + c.name;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  if (process.env.DBG) page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 200)));
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(c.trades, c.renew, c.breakdown, c.valueAdds));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1' + (c.renew ? '&renew=true' : ''), { waitUntil: 'load' });
  await page.waitForFunction(() => { try { return wizardMode === true; } catch (e) { return false; } }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const wiz = await page.evaluate(() => { try { return wizardMode; } catch (e) { return false; } });
  ok(wiz === true, label + ': the page is in wizard mode');
  if (!wiz) { await context.close(); return; }
  if (await page.isVisible('#wizardStep1Next')) await page.click('#wizardStep1Next');
  else await page.evaluate(() => { if (wizardStep === 1) wizardNext(); });
  await page.waitForTimeout(300);
  const queue = await page.evaluate(() => wizardTradeQueue.slice());
  for (let i = 0; i < queue.length; i++) {
    if (await page.evaluate(() => wizardStep) !== 2) break;
    const t = await page.evaluate(() => wizardTradeQueue[wizardCurrentTradeIdx]);
    if (t === 'gutters') {
      const g = await page.evaluate(() => ({ g5: document.getElementById('gutter5InchPrice').value, g6: document.getElementById('gutter6InchPrice').value }));
      if (c.newGutters) await page.fill('#gutter5InchPrice', c.newGutters);
      else ok(money(g.g5) === c.breakdown.gutters || money(g.g6) === c.breakdown.gutters, label + ': the gutters step shows the stored gutters price (' + JSON.stringify(g) + ')');
    }
    if (await page.isVisible('#wizardStep2Next')) await page.click('#wizardStep2Next');
    else await page.evaluate(() => wizardNext());
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  const expectBd = { ...c.breakdown, ...(c.newGutters ? { gutters: Number(c.newGutters) } : {}) };
  const expectTotal = Object.values(expectBd).reduce((a, v) => a + cents(v), 0) / 100;
  const shown = await page.evaluate(() => ({
    step: wizardStep, grand: document.getElementById('wizardGrandTotal')?.textContent,
    bid: document.getElementById('displayBid')?.textContent, feeBox: document.getElementById('totalFeeAmount')?.textContent,
    feeDisclosure: document.getElementById('feeDollarDisplay')?.textContent, feeTick: document.getElementById('feeDollarCheckbox')?.textContent,
    pct: parseFloat(document.getElementById('feePercentDisplay')?.textContent) || null,
  }));
  console.log('     step 3 (' + label + '): ' + JSON.stringify(shown));
  const pct = shown.pct || 5;
  const t2 = cents(expectTotal) * cents(pct) + 5000;
  const expectFee = (t2 - (t2 % 10000)) / 10000 / 100;
  ok(shown.step === 3 && money(shown.grand) === expectTotal, label + ': step 3 Grand Total is the stored sum ' + expectTotal + ' (' + shown.grand + ')');
  ok(money(shown.bid) === expectTotal && money(shown.feeBox) === expectFee, label + ': fee box shows the sum and its fee ' + expectFee + ' (' + shown.bid + ' / ' + shown.feeBox + ')');
  ok(money(shown.feeDisclosure) === expectFee && money(shown.feeTick) === expectFee, label + ': fee disclosure and the figure ticked are ' + expectFee + ' (' + shown.feeDisclosure + ' / ' + shown.feeTick + ')');
  await page.evaluate(() => {
    document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
    window.validateValueAddDeclarations = () => true;
    window.checkBidCanSubmitGate = async () => ({ can_submit: true });
    const cb = document.getElementById('feeAcceptanceCheckbox');
    if (cb && !cb.checked) cb.click();
  });
  await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(2500);
  const writes = await page.evaluate(() => window.__writes);
  const q = writes.find((w) => w.table === 'quotes' && (w.method === 'insert' || w.method === 'update'));
  ok(dialogs.length === 0, label + ': submit raises no alert (' + JSON.stringify(dialogs) + ')');
  ok(!!q, label + ': submit writes the quote');
  if (q) {
    const p = q.payload;
    ok(p.total_price === expectTotal, label + ': stored total_price is the stored sum ' + expectTotal + ' (' + p.total_price + ')');
    ok(JSON.stringify(p.per_trade_breakdown) === JSON.stringify(expectBd), label + ': stored per_trade_breakdown keeps every trade ' + JSON.stringify(expectBd) + ' (' + JSON.stringify(p.per_trade_breakdown) + ')');
    // the server (gh-2519 trigger) stores round(pct/100 * total_price, 2); the client value is overwritten
    const serverFee = Math.round(Number((p.total_price * (pct / 100)).toFixed(6) + 'e2')) / 100;
    ok(serverFee === expectFee, label + ': fee charged on the stored total equals the fee shown (' + serverFee + ' vs ' + expectFee + ')');
  }
  await context.close();
}

const RG = { roofing: 15800, gutters: 2400.13 };
const ALL = { roofing: 15800, gutters: 2400.13, siding: 7999.99 };
// value_adds as a stored wizard bid has it: no gutter_* keys; siding fields only when siding was bid
const VA_RG = { bid_type_option: 'other' };
const VA_ALL = { bid_type_option: 'other', siding_install_per_square: 7999.99 };
const CASES = [
  { name: 'roofing + gutters (stored 18,200.13)', trades: ['roofing', 'gutters'], breakdown: RG, valueAdds: VA_RG, renew: true },
  { name: 'roofing + gutters (stored 18,200.13)', trades: ['roofing', 'gutters'], breakdown: RG, valueAdds: VA_RG, renew: false },
  { name: 'roofing + gutters + siding (stored 26,200.12)', trades: ['roofing', 'gutters', 'siding'], breakdown: ALL, valueAdds: VA_ALL, renew: true },
  { name: 'roofing + gutters + siding (stored 26,200.12)', trades: ['roofing', 'gutters', 'siding'], breakdown: ALL, valueAdds: VA_ALL, renew: false },
  { name: 'roofing + gutters + siding, gutters edited to 3000', trades: ['roofing', 'gutters', 'siding'], breakdown: ALL, valueAdds: VA_ALL, renew: false, newGutters: '3000' },
];

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  for (const c of CASES) { console.log('--- ' + (c.renew ? 'Renew ' : 'Change Bid ') + c.name); await run(browser, base, c); }
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
