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
async function run({ marker, claimError = false, rpcResult = { error: null }, email = OWN, clickRetry = false, legacy = null }) {
  const els = new Map();
  const doc = { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }, createElement() { return makeEl('opt'); } };
  const ls = new Map(); if (marker !== undefined) ls.set(KEY, typeof marker === 'string' ? marker : JSON.stringify(marker));
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  // gh-2355: the marker (name/phone/company) is read from sessionStorage; localStorage must never hold it. `ls` (returned) is the sessionStorage map the marker lives in.
  const lsLegacy = new Map(legacy ? [[KEY, JSON.stringify(legacy)]] : []);
  const realLocal = { getItem: (k) => (lsLegacy.has(k) ? lsLegacy.get(k) : null), setItem: (k, v) => lsLegacy.set(k, String(v)), removeItem: (k) => lsLegacy.delete(k) };
  const sessionStorage = localStorage;
  const rpcCalls = []; let reloads = 0;
  const sb = { rpc: async (name, params) => { rpcCalls.push({ name, params }); return rpcResult; } };
  const win = { location: { reload() { reloads++; } }, localStorage: realLocal, sessionStorage, Auth: { isTestEmail: () => false },
    AgentTypes: { CHOOSER_LABELS: {} } };
  win.window = win;
  const ctx = { window: win, Auth: win.Auth, AgentTypes: win.AgentTypes, document: doc, localStorage: realLocal, sessionStorage, sb, currentUser: { id: 'u1', email }, console: { error() {}, log() {} }, JSON, Date, String, Promise };
  vm.createContext(ctx);
  vm.runInContext(lib, ctx);
  ctx.PartnerRegistration = win.PartnerRegistration;
  vm.runInContext(beginSrc + '\n' + showSrc + '\n;this.__show = showNoPartnerState;', ctx);
  ctx.__show(claimError ? { message: 'claim failed' } : null);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  if (clickRetry) {
    (doc.getElementById('partnerFinishRetry')._l.click || []).forEach((f) => f({}));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  }
  return { rpcCalls, reloads, ls, doc, lsLegacy };
}
const TICK = Date.now() - 60000;
const good = () => ({ email: OWN, ts: Date.now(), termsAcceptedAt: TICK, rpcArgs: {
  p_agent_type: 're_agent', p_first_name: 'Jane', p_last_name: 'Test', p_email: OWN, p_phone: '3175551234', p_company: 'Test Realty',
  p_recruit_code: 'RECRUIT1', p_utm_source: 'facebook', p_utm_medium: 'paid', p_utm_campaign: 'camp1', p_utm_content: 'creative1',
  p_fbclid: 'FB123', p_li_fat_id: 'LI456', p_funnel_id: 'funnel-x', p_is_test: false } });

if (showSrc && beginSrc && lib) {
  // 1. valid marker: automatic completion for the account's own email, then reload.
  let r = await run({ marker: good() });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].name === 'register_partner', '(1) a valid pending marker triggers register_partner once');
  const c0 = r.rpcCalls[0] && r.rpcCalls[0].params;
  ok(c0 && c0.p_email === OWN && c0.p_agent_type === 're_agent' && c0.p_first_name === 'Jane' && c0.p_company === 'Test Realty', '(1) it uses the signed-in email and the marker name/type/company');
  ok(c0 && c0.p_recruit_code === 'RECRUIT1' && c0.p_utm_source === 'facebook' && c0.p_utm_medium === 'paid' && c0.p_utm_campaign === 'camp1' && c0.p_utm_content === 'creative1' && c0.p_fbclid === 'FB123' && c0.p_li_fat_id === 'LI456' && c0.p_funnel_id === 'funnel-x', '(1) recruiter code, UTM, fbclid, li_fat_id and funnel_id from the signup page reach register_partner');
  ok(c0 && c0.p_metadata && c0.p_metadata.completion_path === 'dashboard_marker' && c0.p_metadata.terms_accepted_at_client === new Date(TICK).toISOString(), '(1) p_metadata records completion_path and the ACTUAL client terms time from the marker');
  ok(r.reloads === 1 && !r.ls.has(KEY), '(1) the dashboard reloads and the marker is cleared');
  // 2. no marker: NEVER registers (no terms checkbox was ticked); sends the visitor to the partner signup page.
  r = await run({});
  ok(r.rpcCalls.length === 0 && r.reloads === 0, '(2) no marker: register_partner is never called and the page does not reload');
  ok(r.doc.getElementById('partnerFinishSignup').style.display === 'inline-block' && /href="\/partners\.html"/.test(html.match(/<a href="[^"]*"[^>]*id="partnerFinishSignup"[^>]*>/)[0]), '(2) no marker: a "Go to Partner Signup" link to /partners.html is shown');
  ok(!/id="partnerFinishForm"|partnerFinishFirst/.test(html), '(2) the registration form is gone from the dashboard');
  // 3. marker for another email, 4. expired marker, malformed marker: not used.
  r = await run({ marker: { ...good(), email: 'someone-else@example.invalid' } });
  ok(r.rpcCalls.length === 0 && r.doc.getElementById('partnerFinishSignup').style.display === 'inline-block', '(3) a marker for a different email is ignored (signup link shown, no RPC)');
  r = await run({ marker: { ...good(), ts: Date.now() - 8 * 24 * 60 * 60 * 1000 } });
  ok(r.rpcCalls.length === 0 && !r.ls.has(KEY) && r.doc.getElementById('partnerFinishSignup').style.display === 'inline-block', '(4) an expired (8 day) marker is ignored, removed, and the signup link is shown');
  r = await run({ marker: '{not json' });
  ok(r.rpcCalls.length === 0, '(4) a malformed marker is ignored');
  r = await run({ marker: (() => { const m = good(); delete m.termsAcceptedAt; return m; })() });
  ok(r.rpcCalls.length === 0, '(4) a marker with no terms time is not used');
  // 5. RPC failure: marker kept, error shown, no reload, form available for retry.
  r = await run({ marker: good(), rpcResult: { error: { message: 'rate_limited' } } });
  ok(r.rpcCalls.length === 1 && r.reloads === 0 && r.ls.has(KEY) && r.doc.getElementById('partnerFinishRetry').style.display === 'inline-block' && /support@otterquote\.com/.test(r.doc.getElementById('partnerFinishStatus').textContent), '(5) a rate_limited failure keeps the marker, shows the error and a Try Again button, does not reload');
  r = await run({ marker: good(), rpcResult: { error: { message: 'rate_limited' } }, clickRetry: true });
  ok(r.rpcCalls.length === 2, '(5) Try Again calls register_partner again');
  // 6. partner_exists: a row is already there -> reload so init() claims it.
  r = await run({ marker: good(), rpcResult: { error: { message: 'partner_exists' } } });
  ok(r.reloads === 1 && !r.ls.has(KEY), '(6) partner_exists reloads (the dashboard claim step links the row) and clears the marker');
  // 8. gh-2355: a legacy localStorage copy of the marker (older signup pages) is purged and never used to register.
  r = await run({ marker: good(), legacy: good() });
  ok(!r.lsLegacy.has(KEY), '(8) gh-2355 a legacy localStorage marker is purged by the dashboard');
  r = await run({ legacy: good() });
  ok(r.rpcCalls.length === 0 && !r.lsLegacy.has(KEY), '(8) gh-2355 a localStorage-only marker is never used to register (no PII read from localStorage)');
  // 7. claim failure state must NOT start a registration.
  r = await run({ marker: good(), claimError: true });
  ok(r.rpcCalls.length === 0, '(7) the claim-failed state never calls register_partner');
}
console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
