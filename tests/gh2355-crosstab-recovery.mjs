/**
 * gh-2355 -- cross-tab recovery. PII is no longer persisted in ANY browser storage (the sessionStorage
 * marker is tab-scoped), so a partner whose register_partner failed after signUp and who returns in a NEW
 * tab (confirmation / sign-in link) has no marker. The dashboard must still reach register_partner:
 * it re-collects name/phone/company + a freshly ticked terms checkbox (new termsAcceptedAt), using a
 * NON-PII localStorage context (agent type + attribution) left by the signup page.
 *
 * Two tabs = two storage shims: ONE shared localStorage Map, a fresh sessionStorage Map per tab.
 * Runs the REAL ctx-write statement from each of the 14 signup pages, and the REAL dashboard
 * showNoPartnerState / beginPartnerRegistrationCompletion / renderPartnerRecollect + js/partner-registration.js.
 * Sign-in chain: gh2274 (j)/(k) prove "duplicate + no marker + no session" shows the sign-in message;
 * sign-in lands on the dashboard, exercised here (signed in, no marker, no row).
 *
 * Run: node tests/gh2355-crosstab-recovery.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const KEY = 'oq_partner_pending_registration';
const CTX = 'oq_partner_signup_ctx';
const OWN = 'newtab-user@example.invalid';
const PII = ['Jane', 'Smith', '3175551234', 'Acme Claims Co', OWN];
const html = read('partner-dashboard.html');
const lib = read('js/partner-registration.js');
const store = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const noPii = (st) => ![...st.m.entries()].some(([k, v]) => PII.some((p) => (k + ' ' + v).includes(p)));

function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  return null;
}

// ---- tab A: the REAL ctx-write statement from every signup page, run against a shared localStorage
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html') && read(f).includes("'" + KEY + "'"));
ok(pages.length >= 14, 'discovery: >= 14 signup pages, found ' + pages.length);
function ctxFromPage(file, args, local) {
  const line = read(file).split('\n').find((l) => l.includes("localStorage.setItem('" + CTX + "'"));
  if (!line) return { missing: true };
  const stmt = line.slice(line.indexOf("try { localStorage.setItem('" + CTX + "'"), line.indexOf('// gh-2355: NON-PII'));
  vm.runInContext(stmt, vm.createContext({ localStorage: local, partnerRpcArgs: args, JSON, Date, oqCtxOwner: 'o1:sampletag' /* gh-2344: computed on the statement before, as the pages do */ }));
  return {};
}
const sampleArgs = { p_agent_type: 'adjuster', p_first_name: 'Jane', p_last_name: 'Smith', p_email: OWN, p_phone: '3175551234', p_company: 'Acme Claims Co', p_referred_by_note: 'Jane Smith', p_recruit_code: 'RECRUIT1', p_metadata: { adjuster_type: 'x' },
  p_utm_source: 'facebook', p_utm_medium: 'paid', p_utm_campaign: 'camp1', p_utm_content: 'creative1', p_fbclid: 'FB123', p_li_fat_id: 'LI456', p_funnel_id: 'funnel-x' };
for (const f of pages) {
  const local = store();
  const r = ctxFromPage(f, sampleArgs, local);
  ok(!r.missing, f + ': writes the non-PII signup context');
  if (r.missing) continue;
  const c = JSON.parse(local.getItem(CTX) || 'null');
  ok(!!c && c.agentType === 'adjuster' && c.attribution.p_utm_source === 'facebook' && c.attribution.p_recruit_code === 'RECRUIT1', f + ': ctx carries agent type + attribution');
  ok(noPii(local) && local.m.size === 1, f + ': ctx holds no name/email/phone/company and is the only key');
}

// ---- tab B: dashboard in a NEW tab (fresh sessionStorage), shared localStorage, NO marker
const showSrc = extractFn(html, 'showNoPartnerState');
const beginSrc = extractFn(html, 'beginPartnerRegistrationCompletion');
const recSrc = extractFn(html, 'renderPartnerRecollect');
ok(!!showSrc && !!beginSrc && !!recSrc, 'dashboard has showNoPartnerState, beginPartnerRegistrationCompletion and renderPartnerRecollect');

function mkNode(tag) {
  const n = { tag, style: {}, children: [], _l: {}, appendChild(c) { n.children.push(c); return c; }, addEventListener(t, f) { (n._l[t] = n._l[t] || []).push(f); }, checked: false, value: '', textContent: '' };
  return n;
}
const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };

async function dashboardTab({ local, agentType, values, tick = true, rpcResult = { error: null }, fill = true }) {
  const sess = store(); // NEW TAB: empty sessionStorage
  if (agentType) local.setItem(CTX, JSON.stringify({ ts: Date.now(), agentType, attribution: { p_recruit_code: 'RECRUIT1', p_utm_source: 'facebook', p_utm_medium: 'paid', p_utm_campaign: 'camp1', p_utm_content: 'creative1', p_fbclid: 'FB123', p_li_fat_id: 'LI456', p_funnel_id: 'funnel-x' } }));
  const els = new Map();
  const doc = { getElementById(id) { if (!els.has(id)) els.set(id, mkNode('div')); return els.get(id); }, createElement: (t) => mkNode(t), createTextNode: (t) => ({ text: t, children: [] }) };
  const rpcCalls = []; const alerts = []; let reloads = 0;
  const sb = { rpc: async (name, params) => { rpcCalls.push({ name, params }); return rpcResult; } };
  const win = { location: { reload() { reloads++; } }, localStorage: local, sessionStorage: sess, Auth: { isTestEmail: () => false }, AgentTypes: { CHOOSER_LABELS: {} } };
  win.window = win;
  const ctx = { window: win, Auth: win.Auth, AgentTypes: win.AgentTypes, document: doc, localStorage: local, sessionStorage: sess, sb, currentUser: { id: 'u1', email: OWN }, console: { error() {}, log() {} }, alert: (m) => alerts.push(String(m)), JSON, Date, String, Promise, Object, isFinite };
  vm.createContext(ctx);
  vm.runInContext(lib, ctx);
  ctx.PartnerRegistration = win.PartnerRegistration;
  vm.runInContext(beginSrc + '\n' + showSrc + '\n' + (recSrc || '') + '\n;this.__show = showNoPartnerState;', ctx);
  ctx.__show(null);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const host = doc.getElementById('partnerRecollect');
  const nodes = []; walk(host, (n) => nodes.push(n));
  const byId = (id) => nodes.find((n) => n.id === id);
  if (fill && values) {
    for (const [k, v] of Object.entries(values)) { const n = byId('partnerRecollect_' + k); if (n) n.value = v; }
    const t = byId('partnerRecollect_terms'); if (t) t.checked = tick;
    const form = byId('partnerRecollectForm');
    if (form) { (form._l.submit || []).forEach((f) => f({ preventDefault() {} })); for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); }
  }
  return { rpcCalls, alerts, reloads, sess, host, nodes, doc, byId };
}

if (showSrc && beginSrc && recSrc) {
  const V = { first: 'Jane', last: 'Smith', phone: '3175551234', company: 'Acme Claims Co' };
  const before = Date.now();
  const local = store();
  ctxFromPage('partner-adjusters.html', sampleArgs, local); // tab A: the real page wrote its non-PII ctx; no marker exists in tab B
  let r = await dashboardTab({ local, values: V });
  ok(r.host.style.display === 'block' && !!r.byId('partnerRecollectForm'), '(1) cross-tab: no marker + signed in + no row -> the re-collect form is shown');
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].name === 'register_partner', '(1) cross-tab: the dashboard reaches register_partner through the form -- got ' + JSON.stringify(r.rpcCalls.map((c) => c.name)));
  const p = r.rpcCalls[0] && r.rpcCalls[0].params;
  ok(!!p && p.p_agent_type === 'adjuster' && p.p_first_name === 'Jane' && p.p_last_name === 'Smith' && p.p_phone === '3175551234' && p.p_company === 'Acme Claims Co' && p.p_email === OWN, '(1) args: agent type from the non-PII ctx, name/phone/company as re-entered, email = signed-in email');
  ok(!!p && p.p_recruit_code === 'RECRUIT1' && p.p_utm_source === 'facebook' && p.p_utm_campaign === 'camp1' && p.p_fbclid === 'FB123' && p.p_li_fat_id === 'LI456' && p.p_funnel_id === 'funnel-x', '(1) attribution survives the new tab');
  const at = p && Date.parse(p.p_metadata.terms_accepted_at_client);
  ok(!!p && p.p_metadata.completion_path === 'dashboard_recollect' && at >= before - 1000 && at <= Date.now() + 1000, '(1) termsAcceptedAt is RE-COLLECTED now (fresh), not replayed');
  ok(r.reloads === 1, '(1) reloads after success so init() reads the new row');
  ok(noPii(local) && noPii(r.sess), '(1) no name/email/phone/company key or value written to localStorage or sessionStorage');
  ok(!local.m.has(CTX), '(1) the non-PII ctx is cleared after success');

  r = await dashboardTab({ local: store(), agentType: 'adjuster', values: V, tick: false });
  ok(r.rpcCalls.length === 0 && r.alerts.includes('Please agree to the Partner Terms to continue.'), '(2) unticked terms: no register_partner, page error text shown -- ' + JSON.stringify(r.alerts));
  r = await dashboardTab({ local: store(), agentType: 'adjuster', values: V, rpcResult: { error: { message: 'rate_limited' } } });
  ok(r.rpcCalls.length === 1 && r.reloads === 0 && r.alerts.includes('Something went wrong. Please try again or email us at support@otterquote.com') && r.byId('partnerRecollectSubmit').disabled === false, '(3) register_partner failure: page error text, no reload, form re-enabled');
  r = await dashboardTab({ local: store(), agentType: 'adjuster', values: V, rpcResult: { error: { message: 'partner_exists' } } });
  ok(r.reloads === 1, '(3) partner_exists reloads so the claim step links the row');
  for (const t of [undefined, 'homeowner']) {
    const l2 = store();
    if (t) l2.setItem(CTX, JSON.stringify({ ts: Date.now(), agentType: t, attribution: {} }));
    r = await dashboardTab({ local: l2, values: V });
    ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_agent_type === 'other', '(4) type ' + JSON.stringify(t) + ' -> the other form, agent type "other"');
  }
  const l3 = store();
  l3.setItem(CTX, JSON.stringify({ ts: Date.now() - 31 * 864e5, agentType: 'adjuster', attribution: { p_utm_source: 'x' } }));
  r = await dashboardTab({ local: l3, values: V });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_agent_type === 'other' && r.rpcCalls[0].params.p_utm_source === null, '(4) an expired ctx is ignored');

  r = await dashboardTab({ local: store(), agentType: 'insurance_agent', values: { full: 'Jane van Smith', phone: '3175551234', company: 'Acme Claims Co' } });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_first_name === 'Jane' && r.rpcCalls[0].params.p_last_name === 'van Smith', '(5) insurance_agent: Full Name split into first/last');

  // verbatim strings: every label/placeholder/terms/button/error text exists in the matching signup page
  const PAGE = { re_agent: 'partner-re.html', insurance_agent: 'partner-insurance.html', home_inspector: 'partner-inspectors.html', adjuster: 'partner-adjusters.html', other: 'partner-other.html' };
  const c = { window: {} }; vm.createContext(c); vm.runInContext(lib, c);
  for (const [type, file] of Object.entries(PAGE)) {
    const src = read(file);
    const F = c.window.PartnerRegistration.FORMS[type];
    const strs = [F.submit, F.company.label, F.company.ph, F.phone.label, F.phone.ph, ...(F.first ? [F.first.label, F.first.ph, F.last.label, F.last.ph] : [F.full.label, F.full.err]), F.termsError, F.company.optional].filter(Boolean);
    for (const s of strs) ok(src.includes(s), type + ': "' + s + '" appears verbatim in ' + file);
    for (const t of F.terms) ok(t.a ? src.includes('<a href="' + t.a + '">' + t.t + '</a>') : src.includes(t.t), type + ': terms text/link ' + JSON.stringify(t) + ' verbatim in ' + file);
  }
  ok(read('partner-other.html').includes('Something went wrong. Please try again or email us at support@otterquote.com'), 'error text is verbatim from the signup pages');
  ok(read('partner-other.html').includes('Setting up your account...'), 'submitting text is verbatim from the signup pages');
}
console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
