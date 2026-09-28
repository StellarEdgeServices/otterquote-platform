/**
 * gh-2282 follow-up -- partner-dashboard.html "No Partner Account Found" state
 * completes a partner registration (register_partner for the signed-in user's
 * OWN email) instead of dead-ending, using js/partner-registration.js and the
 * pending marker the signup pages leave on a failed register_partner.
 *
 * Runs the REAL js/partner-registration.js and the REAL showNoPartnerState() /
 * beginPartnerRegistrationCompletion() source extracted from the dashboard
 * page, in a vm behind a small DOM/Supabase shim.
 *
 * Run: node tests/gh2282-dashboard-complete-registration.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const KEY = 'oq_partner_pending_registration';
const OWN = 'stuck-user@example.invalid';
const html = fs.readFileSync(path.join(root, 'partner-dashboard.html'), 'utf8');
const libPath = path.join(root, 'js', 'partner-registration.js');
const lib = fs.existsSync(libPath) ? fs.readFileSync(libPath, 'utf8') : '';

ok(/<script src="js\/partner-registration\.js"><\/script>/.test(html), 'dashboard loads js/partner-registration.js');
ok(lib.length > 0, 'js/partner-registration.js exists');

function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}
const showSrc = extractFn(html, 'showNoPartnerState');
const beginSrc = extractFn(html, 'beginPartnerRegistrationCompletion');
ok(!!showSrc && showSrc.includes('beginPartnerRegistrationCompletion()'), 'showNoPartnerState() starts the completion for the no-record state');
ok(!!beginSrc, 'beginPartnerRegistrationCompletion() exists on the dashboard');

function makeEl(id) {
  const el = { id, style: {}, value: '', textContent: '', children: [], _l: {}, appendChild(c) { el.children.push(c); return c; },
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); } };
  return el;
}
async function run({ marker, claimError = false, rpcResult = { error: null }, email = OWN, form = null }) {
  const els = new Map();
  const doc = { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }, createElement() { return makeEl('opt'); } };
  const ls = new Map(); if (marker !== undefined) ls.set(KEY, typeof marker === 'string' ? marker : JSON.stringify(marker));
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  const rpcCalls = []; let reloads = 0;
  const sb = { rpc: async (name, params) => { rpcCalls.push({ name, params }); return rpcResult; } };
  const win = { location: { reload() { reloads++; } }, localStorage, Auth: { isTestEmail: () => false },
    AgentTypes: { CHOOSER_LABELS: { re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent', home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other' } } };
  win.window = win;
  const ctx = { window: win, Auth: win.Auth, AgentTypes: win.AgentTypes, document: doc, localStorage, sb, currentUser: { id: 'u1', email }, console: { error() {}, log() {} }, JSON, Date, String, Promise };
  vm.createContext(ctx);
  vm.runInContext(lib, ctx);
  ctx.PartnerRegistration = win.PartnerRegistration;
  vm.runInContext(beginSrc + '\n' + showSrc + '\n;this.__show = showNoPartnerState;', ctx);
  ctx.__show(claimError ? { message: 'claim failed' } : null);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  if (form) {
    doc.getElementById('partnerFinishType').value = form.agentType;
    doc.getElementById('partnerFinishFirst').value = form.first;
    doc.getElementById('partnerFinishLast').value = form.last;
    doc.getElementById('partnerFinishPhone').value = form.phone || '';
    (doc.getElementById('partnerFinishForm')._l.submit || []).forEach((f) => f({ preventDefault() {} }));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  }
  return { rpcCalls, reloads, ls, doc };
}
const good = () => ({ email: OWN, agentType: 're_agent', firstName: 'Jane', lastName: 'Test', phone: '3175551234', company: 'Test Realty', ts: Date.now() });

if (showSrc && beginSrc && lib) {
  // 1. valid marker: automatic completion for the account's own email, then reload.
  let r = await run({ marker: good() });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].name === 'register_partner', '(1) a valid pending marker triggers register_partner once');
  ok(r.rpcCalls[0] && r.rpcCalls[0].params.p_email === OWN && r.rpcCalls[0].params.p_agent_type === 're_agent' && r.rpcCalls[0].params.p_first_name === 'Jane' && r.rpcCalls[0].params.p_company === 'Test Realty', '(1) it uses the signed-in email and the marker name/type/company');
  ok(r.reloads === 1 && !r.ls.has(KEY), '(1) the dashboard reloads and the marker is cleared');
  // 2. no marker: minimal form, nothing called until submit; submit registers OWN email.
  r = await run({});
  ok(r.rpcCalls.length === 0 && r.doc.getElementById('partnerFinishForm').style.display === 'block', '(2) no marker: the minimal form is shown and no RPC runs');
  r = await run({ form: { agentType: 'insurance_agent', first: 'Sam', last: 'Rivera', phone: '3175550000' } });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_email === OWN && r.rpcCalls[0].params.p_agent_type === 'insurance_agent' && r.rpcCalls[0].params.p_first_name === 'Sam' && r.reloads === 1, '(2) submitting the form registers the signed-in email with the chosen type/name, then reloads');
  // 3. marker for another email, 4. expired marker, malformed marker: not used.
  r = await run({ marker: { ...good(), email: 'someone-else@example.invalid' } });
  ok(r.rpcCalls.length === 0 && r.doc.getElementById('partnerFinishForm').style.display === 'block', '(3) a marker for a different email is ignored (form shown, no RPC)');
  r = await run({ marker: { ...good(), ts: Date.now() - 8 * 24 * 60 * 60 * 1000 } });
  ok(r.rpcCalls.length === 0 && !r.ls.has(KEY), '(4) an expired (8 day) marker is ignored and removed');
  r = await run({ marker: '{not json' });
  ok(r.rpcCalls.length === 0, '(4) a malformed marker is ignored');
  // 5. RPC failure: marker kept, error shown, no reload, form available for retry.
  r = await run({ marker: good(), rpcResult: { error: { message: 'rate_limited' } } });
  ok(r.rpcCalls.length === 1 && r.reloads === 0 && r.ls.has(KEY) && r.doc.getElementById('partnerFinishForm').style.display === 'block' && /support@otterquote\.com/.test(r.doc.getElementById('partnerFinishStatus').textContent), '(5) a rate_limited failure keeps the marker, shows the error and the retry form, does not reload');
  // 6. partner_exists: a row is already there -> reload so init() claims it.
  r = await run({ marker: good(), rpcResult: { error: { message: 'partner_exists' } } });
  ok(r.reloads === 1 && !r.ls.has(KEY), '(6) partner_exists reloads (the dashboard claim step links the row) and clears the marker');
  // 7. claim failure state must NOT start a registration.
  r = await run({ marker: good(), claimError: true });
  ok(r.rpcCalls.length === 0, '(7) the claim-failed state never calls register_partner');
}
console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
