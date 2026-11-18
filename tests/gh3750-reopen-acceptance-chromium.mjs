/**
 * gh-3750 -- REAL headless-Chromium proof that Change Bid on a WITHDRAWN bid (bid_status 'cancelled') on contractor-bid-form.html
 * reopens it through renew_quote('reopen') and then writes a FRESH fee_acceptances row, built as a first submission builds it
 * (same fields, the fee text the contractor was shown), AFTER the quotes field UPDATE. A live bid's Change Bid and an expired bid's Renew
 * write exactly one row as well since gh-3490 (one block, one row per submission, never two on a reopen). Same harness as gh3495 (real page over local HTTP, stub Supabase client, no network, no secrets).
 * Run: node tests/gh3750-reopen-acceptance-chromium.mjs        Negative control: ROOT=<checkout at 8042784a> ... (expected exit 1)
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
    rpc: function (n, a) { window.__writes.push({ table: 'rpc', method: n, payload: JSON.parse(JSON.stringify(a || {})) }); return Promise.resolve({ data: null, error: null }); },
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
function rows(trades, renew, breakdown, valueAdds, status) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  const total = Object.values(breakdown).reduce((a, v) => a + cents(v), 0) / 100;
  return {
    bidder_claim_summary: { id: 'claim-1', trades, siding_bid_released_at: '2026-01-02T00:00:00Z', job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null, is_test: true },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades: ['roofing', 'gutters', 'siding'], service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false },
    quotes: { id: 'quote-1', claim_id: 'claim-1', contractor_id: 'contractor-1', status: 'submitted', bid_status: status, total_price: total, fee_amount: Math.round(total * 5) / 100, expires_at: new Date(Date.now() + (renew ? -1 : 10) * 864e5).toISOString(), scope_summary: '{}', value_adds: valueAdds, notes: '', auto_renew: true, per_trade_breakdown: breakdown },
  };
}

async function run(browser, base, c) {
  const label = (c.renew ? 'Renew ' : 'Change Bid ') + c.name;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  if (process.env.DBG) page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 200)));
  await page.addInitScript((r) => { window.__ROWS = r; try { localStorage.clear(); } catch (e) {} }, rows(c.trades, c.renew, c.breakdown, c.valueAdds, c.status));
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
  const qi = writes.findIndex((w) => w.table === 'quotes' && (w.method === 'insert' || w.method === 'update'));
  const rpc = writes.find((w) => w.table === 'rpc' && w.method === 'renew_quote');
  const fa = writes.filter((w) => w.table === 'fee_acceptances');
  ok(dialogs.length === 0, label + ': submit raises no alert (' + JSON.stringify(dialogs) + ')');
  ok(qi >= 0, label + ': submit writes the quote');
  if (c.expectFresh) {
    ok(!!rpc && rpc.method === 'renew_quote' && rpc.payload.p_mode === 'reopen' && rpc.payload.p_quote_id === 'quote-1', label + ': renew_quote(reopen) is called on the same quote id (' + JSON.stringify(rpc) + ')');
  } else {
    // gh-3490 rebase: a live bid's Change Bid and an expired bid's Renew are not reopens (no renew_quote('reopen')), but they now record their own acceptance too.
    ok(!rpc || rpc.payload.p_mode !== 'reopen', label + ': not a reopen (' + JSON.stringify(rpc) + ')');
  }
  // One block, one row per submission on EVERY path (gh-3750 reopen; gh-3490 change and renew): exactly one, never two.
  ok(fa.length === 1 && fa[0].method === 'insert', label + ': exactly one fee_acceptances insert (' + fa.length + ')');
  if (fa.length) {
    const p = fa[0].payload;
    ok(p.bid_id === 'quote-1' && p.claim_id === 'claim-1' && p.contractor_id === 'contractor-1', label + ': row names this bid, claim and contractor');
    ok(p.fee_basis === 'bid_amount' && money(p.fee_amount) === expectFee && Number(p.fee_pct) === pct, label + ': fee_pct / fee_amount are the fee shown (' + p.fee_pct + ' / ' + p.fee_amount + ')');
    ok(typeof p.fee_text_displayed === 'string' && p.fee_text_displayed.includes('$' + expectFee.toLocaleString('en-US', { minimumFractionDigits: 2 })) && /By submitting this bid, you agree to pay Otter Quotes/.test(p.fee_text_displayed), label + ': fee_text_displayed is the same disclosure a first submission stores');
    ok(!!p.accepted_at && 'ip_address' in p && 'user_agent' in p, label + ': accepted_at, ip_address, user_agent present as in a first submission');
    ok(!('rescinded_at' in p) && !('rescission_reason' in p) && !('invoice_url' in p), label + ': row carries no rescission or invoice fields');
    const rpcIdx = writes.indexOf(rpc), faIdx = writes.indexOf(fa[0]);
    ok(rpcIdx < qi && qi < faIdx, label + ': order is renew_quote (when called), then the quotes UPDATE, then the acceptance insert (' + rpcIdx + '/' + qi + '/' + faIdx + ')');
  }
  await context.close();
}

const RG = { roofing: 15800, gutters: 2400.13 };
const ALL = { roofing: 15800, gutters: 2400.13, siding: 7999.99 };
// value_adds as a stored wizard bid has it: no gutter_* keys; siding fields only when siding was bid
const VA_RG = { bid_type_option: 'other' };
const VA_ALL = { bid_type_option: 'other', siding_install_per_square: 7999.99 };
const CASES = [
  { name: 'withdrawn (cancelled) bid, reopen', trades: ['roofing', 'gutters'], breakdown: RG, valueAdds: VA_RG, renew: false, status: 'cancelled', expectFresh: true },
  { name: 'withdrawn (cancelled) bid, 3 trades, reopen', trades: ['roofing', 'gutters', 'siding'], breakdown: ALL, valueAdds: VA_ALL, renew: false, status: 'cancelled', expectFresh: true },
  { name: 'live (active) bid', trades: ['roofing', 'gutters'], breakdown: RG, valueAdds: VA_RG, renew: false, status: 'active', expectFresh: false },
  { name: 'expired bid, renew', trades: ['roofing', 'gutters'], breakdown: RG, valueAdds: VA_RG, renew: true, status: 'expired', expectFresh: false },
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
