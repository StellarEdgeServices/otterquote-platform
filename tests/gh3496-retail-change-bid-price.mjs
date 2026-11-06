/**
 * gh-3496 -- REAL headless-Chromium proof that a retail Change Bid and a retail Renew on contractor-bid-form.html load the
 * saved price into the VISIBLE retail price field (#retailBidPrice), so the submit is not stopped at
 * "Please enter your total bid price."
 *
 * Cause: init() calls activateChangeBidMode() (which restores the saved price) BEFORE startUp() calls
 * applyJobTypeCustomizations() (which is what sets isRetailJob). The restore branch tested isRetailJob, which was still
 * false, so only the hidden #totalPrice was filled and #retailBidPrice stayed empty; the retail submit validation reads
 * #retailBidPrice.
 *
 * The real page is served from this repo over a local HTTP server. Every non-local request is aborted except the Supabase
 * CDN script, which is replaced by a small stub client (no network, no real Supabase). Auth.requireAuth is stubbed to return a user.
 *
 * Run: (cd tests/e2e && npm ci) && node tests/gh3496-retail-change-bid-price.mjs      Exit 0 = all green.
 * Negative control: ROOT=<checkout of main before this change> node tests/gh3496-retail-change-bid-price.mjs  (expected exit 1)
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
const SAVED_PRICE = 18500;
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
    var one = function () { var r = ROWS[table]; return Promise.resolve({ data: r === undefined ? null : r, error: r === undefined ? { message: 'none' } : null }); };
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

function rows(renew, multi) {
  const future = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  return {
    bidder_claim_summary: { id: 'claim-1', trades: multi ? ['roofing', 'siding'] : ['roofing'], siding_bid_released_at: multi ? '2026-01-02T00:00:00Z' : null, job_type: 'retail', funding_type: 'cash', damage_type: 'hail', location_city: 'Zionsville', location_zip: '46077', selected_contractor_id: null },
    contractors: { id: 'contractor-1', user_id: 'user-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z', coi_file_url: 'coi.pdf', coi_expires_at: future, company_name: 'Test Roofing', phone: '8445550100', trades: ['roofing'], service_area_description: 'Indiana', cpa_version: CPA_VERSION, needs_cpa_reattestation: false },
    quotes: { id: 'quote-1', claim_id: 'claim-1', contractor_id: 'contractor-1', status: 'submitted', bid_status: renew ? 'expired' : 'active', total_price: SAVED_PRICE, scope_summary: '{}', value_adds: { bid_type_option: 'other' }, notes: '', auto_renew: true }
  };
}

async function run(browser, base, label, renew, multi) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.addInitScript((r) => { window.__ROWS = r; }, rows(renew, multi));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('/@supabase/supabase-js@')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_SDK });
    if (u.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  if (process.env.DBG) { page.on("console", (m) => console.log("   [console]", m.text().slice(0, 200))); page.on("pageerror", (e) => console.log("   [pageerror]", e.message.slice(0, 200))); }
  await page.goto(base + '/contractor-bid-form.html?claim_id=claim-1' + (renew ? '&renew=true' : ''), { waitUntil: 'load' });
  const expectBtn = renew ? 'Renew Bid' : 'Update Bid';
  await page.waitForFunction((t) => { const b = document.getElementById('submitBtn'); return b && b.textContent.trim() === t; }, expectBtn, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); // let startUp()'s applyJobTypeCustomizations() finish
  const m = await page.evaluate(() => {
    const r = document.getElementById('retailBidPrice');
    const sec = document.getElementById('retailPriceSection');
    const vis = (e) => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none';
    return { btn: document.getElementById('submitBtn').textContent.trim(), retail: r ? r.value : null, hidden: document.getElementById('totalPrice').value, retailVisible: vis(r) && vis(sec) };
  });
  console.log('     measured (' + label + '): ' + JSON.stringify(m));
  ok(m.btn === expectBtn, label + ': page is in ' + (renew ? 'Renew' : 'Change Bid') + ' mode (submit button reads "' + expectBtn + '")');
  if (!multi) ok(m.retailVisible, label + ': the retail price field is visible');
  if (multi) {
    // D-162 wizard claim: the wizard has no roofing price field, so no pre-fill; a submit must stop and write nothing.
    ok(m.retail === '', label + ': the retail price field is NOT pre-filled for a wizard claim (' + JSON.stringify(m.retail) + ')');
    // Clear every other gate by script (as a determined submit would) so the only thing left between a submit and a write is the price check.
    await page.evaluate(() => {
      document.querySelectorAll('#bidForm [required]').forEach((el) => el.removeAttribute('required'));
      window.validateValueAddDeclarations = () => true;
      window.checkBidCanSubmitGate = async () => ({ can_submit: true });
    });
  } else {
    ok(m.hidden === String(SAVED_PRICE), label + ': hidden #totalPrice holds the saved price (' + m.hidden + ')');
    ok(m.retail === String(SAVED_PRICE), label + ': the visible retail price field holds the saved price (' + m.retail + ')');
  }
  await page.evaluate(() => document.getElementById('bidForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForTimeout(1200);
  const allWrites = await page.evaluate(() => window.__writes);
  if (process.env.DBG) console.log('   [writes]', JSON.stringify(allWrites).slice(0, 400));
  const writes = allWrites.filter((w) => w.table === 'quotes');
  if (multi) {
    ok(writes.length === 0, label + ': submit writes nothing to quotes (writes: ' + JSON.stringify(writes).slice(0, 200) + ')');
    ok(dialogs.includes(NEEDLE), label + ': submit still stops at "' + NEEDLE + '", as on main (alerts seen: ' + JSON.stringify(dialogs) + ')');
  } else {
    ok(!dialogs.includes(NEEDLE), label + ': submit is not stopped at "' + NEEDLE + '" (alerts seen: ' + JSON.stringify(dialogs) + ')');
  }
  await context.close();
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  await run(browser, base, 'retail Change Bid', false);
  await run(browser, base, 'retail Renew', true);
  await run(browser, base, 'retail roofing + siding Change Bid (wizard)', false, true);
  await run(browser, base, 'retail roofing + siding Renew (wizard)', true, true);
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
