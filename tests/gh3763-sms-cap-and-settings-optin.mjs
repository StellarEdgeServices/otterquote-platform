/**
 * gh-3763 (#3726 item 7): (1) when the monthly Twilio Verify spend cap is hit, contractor-sms-verify answers
 * the distinct code sms_capacity_reached and the client shows the EXISTING approved line (no new wording);
 * (2) contractor-settings.html offers the same verified-per-number opt-in to an already signed-up contractor
 * (source "settings"). The Edge Function side is pinned in supabase/functions/contractor-sms-verify/handler.test.ts.
 *
 * Run: node tests/gh3763-sms-cap-and-settings-optin.mjs     (ROOT=<dir> to point at another checkout)
 * Exit 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = process.env.ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('js/contractor-sms-verify.js');
const SETTINGS = read('contractor-settings.html');

const EXISTING_LINE = 'Text alerts are not available yet. We will use email.';
const V = (() => {
  const module = { exports: {} };
  vm.runInNewContext(SRC, { module, console, Date, Promise, String, Object, Error, Array, RegExp, URL }, { filename: 'contractor-sms-verify.js' });
  return module.exports;
})();

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

const CID = '11111111-1111-4111-8111-111111111111';
const DISCLOSURE = { id: 'contractor-v3-TEST', disclosure_text: 'TEST WORDS' };
function deps(over = {}) {
  const calls = [];
  return { calls, contractorId: CID, loadDisclosure: async () => DISCLOSURE, invoke: async (b) => { calls.push(b); return { data: null, error: { context: { json: async () => ({ success: false, error_code: 'sms_capacity_reached' }) } } }; }, ...over };
}

// 1. The cap code renders the existing approved line, byte for byte, on send and on check.
{
  const d = deps(); const c = V.createController(d); await c.init(); c.setConsent(true);
  const s = await c.sendCode('5155551234');
  ok(s.ok === false && s.error_code === 'sms_capacity_reached', 'sendCode must surface sms_capacity_reached, got ' + JSON.stringify(s));
  ok(s.message === EXISTING_LINE, 'cap message must be the existing line, got ' + JSON.stringify(s.message));
  const k = await c.checkCode('5155551234', '123456');
  ok(k.ok === false && k.message === EXISTING_LINE, 'checkCode cap message must be the existing line, got ' + JSON.stringify(k.message));
  ok(c.state.verified === false && c.state.codeSent === false, 'the cap must never mark anything verified or code-sent');
  ok(V.errorText('sms_capacity_reached') === V.errorText('verify_not_configured'), 'cap line must be the same text as verify_not_configured');
  ok(V.errorText('sms_capacity_reached') !== V.errorText('rate_limited'), 'cap must not fall back to the rate_limited text');
}
// 2. The existing line is not re-worded anywhere: still exactly the approved string.
ok(V.errorText('verify_not_configured') === EXISTING_LINE && V.errorText('disclosure_unavailable') === EXISTING_LINE, 'existing approved line changed');
ok(V.errorText('rate_limited') === 'Too many requests. Wait a few minutes and try again.', 'rate_limited text must be unchanged');

// 3. Source: signup stays the default; the settings page sends "settings".
{
  const d = deps(); const c = V.createController(d); await c.init(); c.setConsent(true); await c.sendCode('5155551234');
  ok(d.calls[0] && d.calls[0].source === 'signup', 'default source must stay signup, got ' + JSON.stringify(d.calls[0] && d.calls[0].source));
  const d2 = deps({ source: 'settings' }); const c2 = V.createController(d2); await c2.init(); c2.setConsent(true); await c2.sendCode('5155551234');
  ok(d2.calls[0] && d2.calls[0].source === 'settings', 'settings controller must send source settings, got ' + JSON.stringify(d2.calls[0] && d2.calls[0].source));
  const d3 = deps({ source: 'reverify<script>' }); const c3 = V.createController(d3); await c3.init(); c3.setConsent(true); await c3.sendCode('5155551234');
  ok(d3.calls[0] && d3.calls[0].source === 'signup', 'only the settings source is accepted from opts');
  ok(d2.calls[0] && d2.calls[0].consent_checked === true && d2.calls[0].disclosure_version_id === DISCLOSURE.id && !JSON.stringify(d2.calls[0]).includes('TEST WORDS'), 'settings request must carry consent_checked + disclosure id, never the text');
}
// 4. mount(..., { source: 'settings' }) wires it through to the real invoke call, still unticked by default.
{
  class N { constructor(t, d) { this.tagName = t; this.ownerDocument = d; this.attrs = {}; this.children = []; this.listeners = {}; this.style = {}; this._text = ''; this.checked = false; this.disabled = false; this.value = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } appendChild(c) { this.children.push(c); return c; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } async fire(t) { for (const f of this.listeners[t] || []) await f({}); }
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    find(p) { if (p(this)) return this; for (const c of this.children) { const r = c.find ? c.find(p) : null; if (r) return r; } return null; } }
  const doc = { createElement: (t) => new N(t, doc), createTextNode: (t) => { const n = new N('#text', doc); n._text = t; return n; } };
  const invokes = [];
  const chain = { select() { return chain; }, is() { return chain; }, lte() { return chain; }, order() { return chain; }, limit() { return chain; }, maybeSingle: async () => ({ data: DISCLOSURE }) };
  const sb = { from: () => chain, functions: { invoke: async (n, o) => { invokes.push(o.body); return { data: null, error: { context: { json: async () => ({ error_code: 'sms_capacity_reached' }) } } }; } } };
  const mountEl = new N('div', doc);
  await V.mount(mountEl, sb, CID, { source: 'settings' });
  const box = mountEl.find((n) => n.attrs.id === 'smsVerifyConsent');
  ok(box && box.checked === false, 'settings mount: consent box must exist and start unticked');
  box.checked = true; await box.fire('change');
  await mountEl.find((n) => n.attrs.id === 'smsVerifySend').fire('click');
  ok(invokes.length === 1 && invokes[0].source === 'settings' && invokes[0].contractor_id === CID, 'settings mount: request must carry source settings + contractor id, got ' + JSON.stringify(invokes));
  ok(mountEl.find((n) => n.attrs.id === 'smsVerifyStatus').textContent === EXISTING_LINE, 'settings mount: cap must show the existing line on screen');
}
// 5. The page: loads the script, has the mount host, mounts with source settings after the contractor row is known, adds no wording.
{
  ok(/<script src="js\/contractor-sms-verify\.js"><\/script>/.test(SETTINGS), 'contractor-settings.html does not load js/contractor-sms-verify.js');
  ok(/getElementById\('phoneList'\)/.test(SETTINGS) && /host\.id = 'smsVerifyMount'/.test(SETTINGS) && /insertBefore\(host, section\.nextSibling\)/.test(SETTINGS), 'settings page must create the #smsVerifyMount host right after the Phone Numbers block');
  ok(/window\.OQSmsVerify\.mount\(.*contractorRecord.*\{\s*source:\s*'settings'\s*\}\s*\)/.test(SETTINGS), 'settings page must mount OQSmsVerify with source settings');
  const at = SETTINGS.indexOf('contractorRecord = data;');
  const call = SETTINGS.indexOf('mountSmsVerify();');
  ok(at > -1 && call > at, 'mountSmsVerify() must run after contractorRecord is set');
  // The page body gains no wording: the host is created empty by script, and the only added element in HTML is the <script> tag.
  ok(!/id="smsVerifyMount"/.test(SETTINGS), 'the page body must not carry a hard-coded #smsVerifyMount block (the host is script-created and empty)');
  ok(!/I agree to receive|Msg & data rates|Reply STOP|consent is not a condition/i.test(SETTINGS), 'no consent wording may sit in the settings page');
  // The mount function runs against a fake DOM: an empty host is inserted right after the phone-list section, then mounted with source settings.
  const fn = SETTINGS.slice(SETTINGS.indexOf('function mountSmsVerify() {'), SETTINGS.indexOf('async function initSettings()'));
  const inserted = []; const mounts = [];
  const section = { parentNode: { insertBefore: (n, ref) => inserted.push({ n, ref }) }, nextSibling: 'NEXT' };
  const fakeDocument = { getElementById: (id) => (id === 'phoneList' ? { closest: (sel) => (sel === '.notifications-section' ? section : null) } : null), createElement: () => ({ setAttribute() {} }) };
  ok(fn.startsWith('function mountSmsVerify'), 'contractor-settings.html has no mountSmsVerify()');
  const run = fn.startsWith('function mountSmsVerify') ? new Function('window', 'document', 'sb', 'contractorRecord', 'console', fn + '; mountSmsVerify();') : () => {};
  run({ OQSmsVerify: { mount: (h, sbx, id, o) => mounts.push({ h, id, o }) } }, fakeDocument, { SB: 1 }, { id: CID }, console);
  ok(inserted.length === 1 && inserted[0].ref === 'NEXT' && inserted[0].n.id === 'smsVerifyMount', 'mountSmsVerify must insert the host right after the phone-list section');
  ok(mounts.length === 1 && mounts[0].id === CID && mounts[0].o && mounts[0].o.source === 'settings' && mounts[0].h === (inserted[0] && inserted[0].n), 'mountSmsVerify must mount on the new host with the contractor id and source settings');
  ok(!/<input[^>]*type="checkbox"[^>]*\bchecked\b[^>]*id="smsVerify/i.test(SETTINGS), 'no pre-ticked verify box in the page');
}

assert.deepEqual(fails, [], 'gh-3763 checks failed: ' + fails.join(' | '));
console.log('PASS: gh-3763 cap code renders the existing line; settings opt-in uses source settings through the verified flow');
