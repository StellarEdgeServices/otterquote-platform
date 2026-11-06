// gh-3443: switch-survey success text must show only after the send succeeded. No new wording:
// the failure path is the page's existing catch (same alert text). Real submitSwitchSurvey source run in vm.
// Run from repo root: node tests/gh3443-switch-survey-failure.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SRC = readFileSync('dashboard.html', 'utf8');
const a = SRC.indexOf('window.submitSwitchSurvey = async function submitSwitchSurvey()');
assert.ok(a >= 0, 'submitSwitchSurvey missing');
const b = SRC.indexOf('// gh-1276 follow-up', a);
assert.ok(b > a, 'end marker missing');
const code = SRC.slice(a, b);
const FAIL_MSG = 'There was a problem submitting your request. Please try again or contact support.';

let n = 0; const fails = [];
async function check(name, fn) { try { await fn(); console.log('ok ' + (++n) + ' - ' + name); } catch (e) { fails.push(name); console.log('NOT OK - ' + name + ' :: ' + String(e.message).split('\n')[0]); } }

async function run(fetchImpl, over = {}) {
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), has: (c) => s.has(c) }; };
  const els = {
    'submit-switch-btn': Object.assign(cls(), { disabled: false, textContent: '' }),
    'switch-notes': { value: ' n ' },
    'switch-survey-step': { classList: cls() },
    'switch-success-step': { classList: cls() },
  };
  els['switch-survey-step'].classList = cls();
  els['switch-success-step'].classList = cls();
  const alerts = [];
  let calls = 0;
  const wrapped = (...a) => { calls++; return fetchImpl(...a); };
  const ctx = {
    window: {}, console: { error() {} }, alert: (m) => alerts.push(m),
    document: { getElementById: (id) => els[id], querySelectorAll: () => [] },
    sb: {}, currentClaim: { id: 'abcdef12345678' }, currentProfile: { full_name: 'H' }, currentUser: { email: 'h@x.co' },
    CONFIG: { SUPABASE_URL: 'https://x.test', SUPABASE_ANON: 'k' }, fetch: wrapped, JSON,
    ...over,
  };
  vm.runInNewContext(code, ctx);
  await ctx.window.submitSwitchSurvey();
  return { success: els['switch-success-step'].classList.has('visible'), alerts, btn: els['submit-switch-btn'], calls };
}

await check('failed send (HTTP 500): failure message shown, success text NOT shown, button re-enabled', async () => {
  const r = await run(async () => ({ ok: false, status: 500 }));
  assert.equal(r.success, false, 'success text shown after failed send');
  assert.deepEqual(r.alerts, [FAIL_MSG]);
  assert.equal(r.btn.disabled, false);
  assert.equal(r.btn.textContent, 'Submit Switch Request');
});
await check('thrown network error: failure message shown, success text NOT shown', async () => {
  const r = await run(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(r.success, false);
  assert.deepEqual(r.alerts, [FAIL_MSG]);
  assert.equal(r.btn.disabled, false);
  assert.equal(r.btn.textContent, 'Submit Switch Request');
});
for (const [label, over] of [['sb missing', { sb: null }], ['currentClaim missing', { currentClaim: null }], ['currentClaim.id missing', { currentClaim: {} }]]) {
  await check(label + ': no request made, success text NOT shown, failure message shown, button retryable', async () => {
    const r = await run(async () => ({ ok: true, status: 200 }), over);
    assert.equal(r.calls, 0, 'fetch must not be called');
    assert.equal(r.success, false, 'success text shown with no request made');
    assert.deepEqual(r.alerts, [FAIL_MSG]);
    assert.equal(r.btn.disabled, false);
    assert.equal(r.btn.textContent, 'Submit Switch Request');
  });
}
await check('successful send (200): success text shown, no failure message', async () => {
  const r = await run(async () => ({ ok: true, status: 200 }));
  assert.equal(r.success, true);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.calls, 1);
});
assert.ok(SRC.includes(FAIL_MSG)); // wording is pre-existing on the page
if (fails.length) { console.log('FAIL ' + fails.length + ' of ' + (n + fails.length)); process.exit(1); }
console.log('PASS ' + n);
