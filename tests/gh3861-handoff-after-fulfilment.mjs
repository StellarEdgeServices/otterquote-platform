/**
 * gh-3861 (P23 piece E) -- admin-measurements.html "Save & deliver" and the contractor hand-off.
 *
 * Extracts the REAL saveFulfillment() from the page and runs it in vm against fakes (no network, no
 * email, no SMS: the only door is a fetch stub that records the Edge Function name called). Asserts:
 *   - flag ON, order delivered on an is_test claim: send-measurement-ready (the homeowner ready email) is
 *     called, THEN hand-off-after-fulfilment, each exactly once (the hand-off is what invokes notify-contractors
 *     server-side, once; see supabase/functions/hand-off-after-fulfilment/hand-off.test.ts);
 *   - flag OFF (the default in js/config.js): the same save calls send-measurement-ready only;
 *     hand-off-after-fulfilment is NOT called (this is also the state of unfixed main);
 *   - a hand-off failure alerts the admin but does not un-deliver the order.
 *
 * Run: node tests/gh3861-handoff-after-fulfilment.mjs
 * GH3861_ROOT points at another tree for negative controls (e.g. a checkout of main).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH3861_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'admin-measurements.html'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const start = html.indexOf('async function saveFulfillment()');
ok(start !== -1, 'admin-measurements.html defines saveFulfillment()');
const end = html.indexOf('\n}\n', start);
const fnSrc = html.slice(start, end + 3);

ok(/MEASUREMENT_CHARGE_ENABLED:\s*false/.test(cfgSrc), 'js/config.js ships MEASUREMENT_CHARGE_ENABLED: false (dark by default)');

async function save({ flag, handOffStatus = 200, handOffBody = {}, status = 'awaiting_fulfillment' }) {
  const fnCalls = [];
  const alerts = [];
  const writes = [];
  const el = () => ({ value: '', files: [], style: {}, textContent: '', disabled: false });
  const sbStub = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-admin-jwt' } } }) },
    from: (t) => {
      const b = {
        update: (p) => { writes.push(t); return b; },
        eq: () => b,
        select: () => Promise.resolve({ data: [{ id: 'x' }], error: null }),
      };
      return b;
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
  const ctx = vm.createContext({
    state: { current: { id: 'order-1', claim_id: 'claim-1', status, report_url: null }, user: { id: 'u1', email: 'admin@example.test' } },
    document: { getElementById: () => el() },
    sb: sbStub,
    CONFIG: { SUPABASE_URL: 'https://x.supabase.co', MEASUREMENT_CHARGE_ENABLED: flag },
    STORAGE_BUCKET: 'claim-documents',
    window: { MeasurementShape: { shouldFlipMeasurementShapeOnDeliver: () => false } },
    alert: (m) => alerts.push(m),
    closeDrawer: () => {}, loadOrders: async () => {},
    numOrNull: (id) => (id === 'mSquares' ? 20 : null),   // Dustin typed a number: "delivering"
    collectPitchRows: () => null,
    rowsWritten: (r) => !!r && !r.error && Array.isArray(r.data) && r.data.length > 0,
    ZERO_ROW_USER_MESSAGE: 'zero', userFacingWriteMessage: (e) => String(e && e.message),
    Sentry: undefined, console: { error() {}, log() {}, warn() {} },
    fetch: async (url, init) => {
      const name = String(url).split('/functions/v1/')[1];
      fnCalls.push({ name, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: name === 'hand-off-after-fulfilment' ? handOffStatus < 400 : true, status: name === 'hand-off-after-fulfilment' ? handOffStatus : 200, json: async () => (name === 'hand-off-after-fulfilment' ? handOffBody : {}) };
    },
    Date, JSON, Math, parseFloat, isNaN, Promise,
  });
  vm.runInContext(fnSrc + '\nthis.saveFulfillment = saveFulfillment;', ctx);
  await ctx.saveFulfillment();
  return { fnCalls, alerts, writes };
}

// 1. flag ON: ready email, then the hand-off, once each.
{
  const r = await save({ flag: true });
  const names = r.fnCalls.map((c) => c.name);
  console.log('flag ON  calls:', JSON.stringify(names));
  ok(JSON.stringify(names) === JSON.stringify(['send-measurement-ready', 'hand-off-after-fulfilment']), 'flag ON: send-measurement-ready THEN hand-off-after-fulfilment, once each');
  ok(r.fnCalls.every((c) => c.body.order_id === 'order-1' && c.auth === 'Bearer fixture-admin-jwt'), 'flag ON: both calls carry the order id and the admin JWT');
  ok(r.alerts.length === 0, 'flag ON: no admin alert on success');
}
// 2. flag OFF: no hand-off (== main).
{
  const r = await save({ flag: false });
  const names = r.fnCalls.map((c) => c.name);
  console.log('flag OFF calls:', JSON.stringify(names));
  ok(JSON.stringify(names) === JSON.stringify(['send-measurement-ready']), 'flag OFF: only send-measurement-ready (ready email still sent), NO hand-off call');
}
// 2b. flag absent entirely (an older config.js): also off.
{
  const r = await save({ flag: undefined });
  ok(r.fnCalls.every((c) => c.name !== 'hand-off-after-fulfilment'), 'flag undefined: NO hand-off call');
}
// 3. hand-off failure: admin told, order stays delivered (no throw; the save reached loadOrders/closeDrawer).
{
  const r = await save({ flag: true, handOffStatus: 502 });
  ok(r.alerts.length === 1 && /handing the job to contractors failed/.test(r.alerts[0]), 'hand-off failure: one admin-facing alert');
  ok(r.writes.includes('hover_orders'), 'hand-off failure: the delivery write already stood (order not un-delivered)');
}
// 4. re-save of an already delivered order also reaches the (idempotent) hand-off, so a failed one is retryable.
{
  const r = await save({ flag: true, status: 'completed' });
  ok(r.fnCalls.map((c) => c.name).includes('hand-off-after-fulfilment'), 're-save of a completed order re-calls the hand-off (server is idempotent per order)');
}
// 5. notify failed (502 notify_failed, 429 behind it): the admin is told plainly that contractors are NOT notified yet and to Save again.
{
  const r = await save({ flag: true, handOffStatus: 502, handOffBody: { error: 'notify_failed', released: true, notified: false, notify_status: 429 } });
  ok(r.alerts.length === 1 && /contractors have NOT been notified yet/.test(r.alerts[0]) && /429/.test(r.alerts[0]) && /Save again to retry the notification/.test(r.alerts[0]), 'notify_failed (429): admin warned that contractors are not yet notified, with the status, and told to Save again');
}
// 6. the done record failed after a successful notify: the admin is told NOT to save again (a re-save would notify twice).
{
  const r = await save({ flag: true, handOffStatus: 502, handOffBody: { error: 'handoff_record_failed', released: true, notified: true } });
  ok(r.alerts.length === 1 && /Do NOT Save again/.test(r.alerts[0]), 'handoff_record_failed: admin told not to Save again');
}
// 7. the page's own wiring: it never says a re-save retries unless the function can (the string and the function agree).
ok(/notify_failed/.test(html) && /handoff_record_failed/.test(html), 'page handles both failure codes the function returns');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
