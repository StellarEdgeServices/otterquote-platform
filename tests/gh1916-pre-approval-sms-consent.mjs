/**
 * gh-1916 / D-391 (#2875): the contractor text-alert opt-in at signup.
 *
 * REWRITTEN from the D-328 checkbox test. The "I agree to receive SMS" checkbox on
 * contractor-join.html (#smsConsent) and contractor-pre-approval.html (#agreeTcpaSms) is gone.
 * Opt-in is now: a ticked, never-pre-ticked box + a one-time code to the number, built by
 * js/contractor-sms-verify.js on contractor-pre-approval.html step 3. The consent sentence is read
 * from the current public.sms_disclosure_versions row; it is not written in any page or script.
 *
 * Run: node tests/gh1916-pre-approval-sms-consent.mjs     Exit 0 = pass, 1 = fail.
 * Proves, with negative controls (mutants of the real source must FAIL these checks):
 *   - unticked => no request is made, nothing is recorded, no number can become textable;
 *   - no current disclosure row => the screen offers nothing and makes no request;
 *   - only a success answer from the Edge Function marks a number verified;
 *   - the consent words on screen are the stored row's, verbatim, as text (never parsed as HTML).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('js/contractor-sms-verify.js');

function load(src) {
  const module = { exports: {} };
  vm.runInNewContext(src, { module, console, Date, Promise, String, Object, Error, Array }, { filename: 'contractor-sms-verify.js' });
  return module.exports;
}

// ---------------------------------------------------------------- fakes
const DISCLOSURE = { id: 'contractor-v3-TEST', disclosure_text: 'TEST WORDS <b>not html</b> & more' };

function fakeDeps({ disclosure = DISCLOSURE, reply = { data: { success: true, number_id: 'n1' }, error: null } } = {}) {
  const calls = [];
  return {
    calls,
    contractorId: '11111111-1111-4111-8111-111111111111',
    loadDisclosure: async () => disclosure,
    invoke: async (b) => { calls.push(b); return typeof reply === 'function' ? reply(b) : reply; },
  };
}

class FakeNode {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.attrs = {}; this.children = []; this.listeners = {}; this.style = {}; this._text = ''; this.checked = false; this.disabled = false; this.value = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({}); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find ? c.find(pred) : null; if (r) return r; } return null; }
}
const fakeDoc = () => { const d = { createElement: (t) => new FakeNode(t, d), createTextNode: (t) => { const n = new FakeNode('#text', d); n._text = t; return n; } }; return d; };

function fakeSb({ disclosure = DISCLOSURE, invokeReply = { data: { success: true }, error: null } } = {}) {
  const invokes = [];
  const chain = { select() { return chain; }, is() { return chain; }, lte() { return chain; }, order() { return chain; }, limit() { return chain; }, maybeSingle: async () => ({ data: disclosure }) };
  return { invokes, from: (t) => { assert.equal(t, 'sms_disclosure_versions'); return chain; }, functions: { invoke: async (n, o) => { invokes.push({ n, body: o.body }); return invokeReply; } } };
}

// ---------------------------------------------------------------- the checks (run against any source, for mutation)
export async function runChecks(src) {
  const V = load(src);
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };

  // 1. NEGATIVE CONTROL: unticked => no request, no record.
  {
    const d = fakeDeps(); const c = V.createController(d); await c.init();
    ok(c.state.consentChecked === false, 'box must start unticked');
    const s = await c.sendCode('5155551234'); const k = await c.checkCode('5155551234', '123456');
    ok(s.ok === false && s.error_code === 'consent_required', 'sendCode must refuse when unticked');
    ok(k.ok === false && k.error_code === 'consent_required', 'checkCode must refuse when unticked');
    ok(d.calls.length === 0, 'unticked made ' + d.calls.length + ' request(s); must be 0');
    ok(c.state.verified === false, 'unticked must never be verified');
  }
  // 2. Ticked: request carries consent_checked, the disclosure ID (not text), source signup.
  {
    const d = fakeDeps(); const c = V.createController(d); await c.init(); c.setConsent(true);
    const s = await c.sendCode('5155551234');
    ok(s.ok === true && d.calls.length === 1, 'ticked sendCode should make exactly one request');
    const b = d.calls[0] || {};
    ok(b.action === 'start' && b.consent_checked === true && b.disclosure_version_id === DISCLOSURE.id && b.source === 'signup' && b.contractor_id === d.contractorId, 'start body wrong: ' + JSON.stringify(b));
    ok(!JSON.stringify(b).includes('TEST WORDS'), 'client must never send consent text; the server reads it');
  }
  // 3. No current disclosure row => nothing offered, no request.
  {
    const d = fakeDeps({ disclosure: null }); const c = V.createController(d);
    ok((await c.init()) === false, 'init must report unavailable with no disclosure row');
    c.setConsent(true);
    const s = await c.sendCode('5155551234');
    ok(s.ok === false && d.calls.length === 0, 'no disclosure row must make no request');
    const d2 = fakeDeps({ disclosure: { id: 'x', disclosure_text: '   ' } }); const c2 = V.createController(d2);
    ok((await c2.init()) === false, 'blank disclosure text must count as unavailable');
  }
  // 4. Only success marks verified; wrong code / error never does.
  {
    const d = fakeDeps({ reply: { data: { success: false, error_code: 'wrong_code' }, error: null } });
    const c = V.createController(d); await c.init(); c.setConsent(true);
    const k = await c.checkCode('5155551234', '000000');
    ok(k.ok === false && c.state.verified === false && k.error_code === 'wrong_code', 'wrong code must not verify');
    const d2 = fakeDeps({ reply: { data: null, error: { context: { json: async () => ({ error_code: 'rate_limited' }) } } } });
    const c2 = V.createController(d2); await c2.init(); c2.setConsent(true);
    const k2 = await c2.checkCode('5155551234', '123456');
    ok(k2.ok === false && k2.error_code === 'rate_limited' && c2.state.verified === false, 'http error must surface its error_code and not verify');
    const d3 = fakeDeps(); const c3 = V.createController(d3); await c3.init(); c3.setConsent(true);
    const k3 = await c3.checkCode('5155551234', '123456');
    ok(k3.ok === true && c3.state.verified === true, 'approved code should verify');
  }
  // 5. Un-ticking after a code was sent withdraws the request.
  {
    const d = fakeDeps(); const c = V.createController(d); await c.init(); c.setConsent(true); await c.sendCode('5155551234');
    c.setConsent(false);
    const k = await c.checkCode('5155551234', '123456');
    ok(k.ok === false && d.calls.length === 1 && c.state.codeSent === false, 'un-ticking must withdraw: no check request after');
  }
  // 6. The screen: unticked, verbatim text, controls disabled, click while unticked is a no-op.
  {
    const sb = fakeSb(); const doc = fakeDoc(); const mountEl = new FakeNode('div', doc);
    await V.mount(mountEl, sb, '11111111-1111-4111-8111-111111111111');
    const box = mountEl.find((n) => n.attrs.id === 'smsVerifyConsent');
    const label = mountEl.find((n) => n.tagName === 'label');
    const send = mountEl.find((n) => n.attrs.id === 'smsVerifySend');
    ok(!!box && box.checked === false && !('checked' in box.attrs), 'screen box must exist and be unticked');
    ok(label && label.textContent === DISCLOSURE.disclosure_text, 'label must be the stored disclosure text verbatim');
    ok(send && send.disabled === true, 'Send code must start disabled');
    await send.fire('click');
    ok(sb.invokes.length === 0, 'clicking Send code while unticked made a request');
    box.checked = true; await box.fire('change');
    ok(send.disabled === false, 'ticking the box must enable Send code');
    const sbN = fakeSb({ disclosure: null }); const m2 = new FakeNode('div', doc);
    await V.mount(m2, sbN, '11111111-1111-4111-8111-111111111111');
    ok(m2.find((n) => n.attrs.type === 'checkbox') === null && m2.find((n) => n.attrs['data-oq-sms'] === 'unavailable'), 'no disclosure row: no checkbox, one unavailable line');
  }
  // 7. LEGAL-READ 6545940873 F1/F2: opted-out message names START; success line promises nothing.
  {
    const m = V.errorText('number_suppressed');
    ok(/texting START first/.test(m), 'number_suppressed message must say re-adding requires texting START first');
    const sb = fakeSb(); const doc = fakeDoc(); const mountEl = new FakeNode('div', doc);
    await V.mount(mountEl, sb, '11111111-1111-4111-8111-111111111111');
    const box = mountEl.find((n) => n.attrs.id === 'smsVerifyConsent');
    box.checked = true; await box.fire('change');
    await mountEl.find((n) => n.attrs.id === 'smsVerifySend').fire('click');
    await mountEl.find((n) => n.attrs.id === 'smsVerifyCheck').fire('click');
    const st = mountEl.find((n) => n.attrs.id === 'smsVerifyStatus').textContent;
    ok(st === 'Number verified and saved.', 'success line must be exactly the true statement, got ' + JSON.stringify(st));
    ok(!/will get|alerts at/i.test(st), 'success line must not promise alerts');
  }
  return fails;
}

const real = await runChecks(SRC);
assert.deepEqual(real, [], 'real source failed: ' + real.join(' | '));
console.log('PASS: contractor SMS verify screen: unticked = no request, no record; verbatim stored text; success-only verification');

// ---------------------------------------------------------------- negative controls: mutants must be caught
async function mustFail(name, src, needle) {
  assert.notEqual(src, SRC, name + ': mutation did not change the source');
  const out = await runChecks(src);
  assert.ok(out.some((s) => s.includes(needle)), `${name}: expected a failure containing ${JSON.stringify(needle)}, got ${JSON.stringify(out)}`);
  console.log('PASS (negative control): ' + name);
}
await mustFail('consent guard removed from sendCode', SRC.replace("if (state.consentChecked !== true) return { ok: false, error_code: 'consent_required', message: errorText('consent_required') };\n      if (state.busy) return { ok: false, error_code: 'busy', message: GENERIC_ERROR };\n      state.busy = true;\n      try {\n        var res = await deps.invoke(body('start'", "if (state.busy) return { ok: false, error_code: 'busy', message: GENERIC_ERROR };\n      state.busy = true;\n      try {\n        var res = await deps.invoke(body('start'"), 'unticked made');
await mustFail('box pre-ticked', SRC.replace('consentChecked: false, // never pre-ticked', 'consentChecked: true,'), 'unticked');
await mustFail('failure treated as verified', SRC.replace("state.verified = true; state.verifiedPhone = phone;", "state.verified = true; state.verifiedPhone = phone; /*always*/").replace("if (!res.error && res.data && res.data.success === true) {\n          state.verified", "if (true) {\n          state.verified"), 'must not verify');
await mustFail('disclosure written with innerHTML-style parsing', SRC.replace("ctl.state.disclosure.disclosure_text); // verbatim, as text", "ctl.state.disclosure.disclosure_text.replace(/<[^>]*>/g, '')); // verbatim, as text"), 'verbatim');
await mustFail('START step dropped from opted-out message', SRC.replaceAll('requires texting START first', 'is not possible'), 'texting START first');
await mustFail('success line promises alerts', SRC.replace("'Number verified and saved.'", "'Number verified. You will get text alerts at this number.'"), 'promise alerts');
await mustFail('no-disclosure still offered', SRC.replace("if (d && typeof d.id === 'string' && d.id && typeof d.disclosure_text === 'string' && d.disclosure_text.trim() !== '') {", "if (d) {"), 'blank disclosure');

// ---------------------------------------------------------------- the pages
const pre = read('contractor-pre-approval.html');
const join = read('contractor-join.html');
const page = [];
const chk = (c, m) => { if (!c) page.push(m); };
chk(/id="smsVerifyMount"/.test(pre), 'pre-approval has no #smsVerifyMount');
chk(/<script src="js\/contractor-sms-verify\.js"><\/script>/.test(pre), 'pre-approval does not load js/contractor-sms-verify.js');
chk(!/agreeTcpaSms/.test(pre), 'pre-approval still has the D-328 #agreeTcpaSms box');
chk(!/<input[^>]*type="checkbox"[^>]*\bchecked\b[^>]*>/i.test(pre.slice(pre.indexOf('id="smsVerifyMount"'), pre.indexOf('id="smsVerifyMount"') + 800)), 'a pre-ticked checkbox sits in the SMS block');
chk(!/sms_opt_in\s*:/.test(pre) && !/sms_consent_ts\s*:\s*now/.test(pre), 'pre-approval still writes legacy sms_opt_in / sms_consent_ts');
chk(!/id="smsConsent"/.test(join) && !/smsConsent/.test(join), 'contractor-join still has the D-328 smsConsent box');
chk(!/sms_opt_in\s*:/.test(join), 'contractor-join still stores sms_opt_in');
chk(!/I agree to receive/i.test(pre + join + SRC), 'a hard-coded consent sentence is still in a page or script');
chk(/function mountSmsVerify/.test(pre) && /if \(n === 3\) mountSmsVerify\(\)/.test(pre), 'step 3 does not mount the screen');
chk(!/'agreeTcpaSms'/.test(pre) && /'agreeToPartnerAgreement','agreeToCancellationPolicy','agreeToAttestation'\]/.test(pre), 'submitStep3 required list changed unexpectedly');
assert.deepEqual(page, [], 'pages: ' + page.join(' | '));
console.log('PASS: pages carry the verify mount, no D-328 box, no legacy opt-in writes, no hard-coded consent sentence');

const pageMut = (name, mutated, needle) => {
  const out = [];
  const c2 = (c, m) => { if (!c) out.push(m); };
  c2(!/agreeTcpaSms/.test(mutated), 'pre-approval still has the D-328 #agreeTcpaSms box');
  c2(!/I agree to receive/i.test(mutated), 'a hard-coded consent sentence is still in a page or script');
  assert.ok(out.some((s) => s.includes(needle)), `${name}: not caught: ${JSON.stringify(out)}`);
  console.log('PASS (negative control): ' + name);
};
pageMut('old checkbox restored', pre.replace('id="smsVerifyMount"', 'id="smsVerifyMount"><input type="checkbox" id="agreeTcpaSms"><i'), 'D-328');
pageMut('hard-coded sentence restored', pre.replace('Text alerts (optional)', 'I agree to receive SMS from Otter Quotes'), 'hard-coded');
