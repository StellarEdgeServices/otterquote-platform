#!/usr/bin/env node
// gh-2344 follow-up (after #2357): every partner/RE/HI/INS signup page stamps the cs_auth_role breadcrumb owner,
// and the non-PII oq_partner_signup_ctx is bound to the signup email (#2355 ruling item b).
// Static + vm test. Run: node tests/gh2344-partner-site-owner-stamp.mjs   (ROOT=<dir> to test another tree)
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.join(__dirname, '..');
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) fail++; };
const PAGES = ['hi-1','hi-4','hi-5','ins-1','ins-3','ins-5','partner-adjusters','partner-inspectors','partner-insurance','partner-other','partner-re','re-1','re-3','re-5'];
for (const p of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, p + '.html'), 'utf8').split('\n');
  const writes = src.map((l, i) => (l.includes("localStorage.setItem('cs_auth_role_at'") ? i : -1)).filter((i) => i >= 0);
  ok(writes.length > 0, p + ': has cs_auth_role_at write site(s) (' + writes.length + ')');
  for (const i of writes) ok(/Auth\.stampRoleOwner\(/.test((src[i + 1] || '') + (src[i - 1] || '')), p + ':' + (i + 1) + ': owner stamped on the line after the role_at write');
  const all = src.join('\n');
  if (all.includes("setItem('oq_partner_signup_ctx'")) ok(/setItem\('oq_partner_signup_ctx', JSON\.stringify\(\{ ts: Date\.now\(\), owner: oqCtxOwner,/.test(all) && /oqCtxOwner = Auth\.ownerTag\(email\)/.test(all), p + ': signup ctx carries the hashed owner tag (not the email)');
}
const google = fs.readFileSync(path.join(ROOT, 'partner-insurance.html'), 'utf8');
ok(/stampRoleOwner\(null\)/.test(google), 'partner-insurance Google path stamps oauth-tab owner (null email)');
ok(/removeItem\('cs_auth_role_email'\)/.test(google), 'partner-insurance failed-Google cleanup also clears cs_auth_role_email');
// readCtx owner binding (real js/partner-registration.js + real Auth.ownerTag from js/auth.js, in a vm)
const win = {}; const ctxObj = { window: win, console };
vm.createContext(ctxObj); vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'partner-registration.js'), 'utf8'), ctxObj);
const PR = win.PartnerRegistration || ctxObj.PartnerRegistration;
const authSrc = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
const m = authSrc.match(/  ownerTag\(email\) \{[\s\S]*?\n  \},\n/);
ok(!!m, 'js/auth.js defines Auth.ownerTag');
const Auth = m ? vm.runInNewContext('({' + m[0].replace(/,\s*$/, '') + '})') : { ownerTag: () => '' };
const tag = (e) => Auth.ownerTag(e);
ok(tag('A@X.com ') === tag('a@x.com') && tag('a@x.com') !== tag('b@x.com') && /^o1:/.test(tag('a@x.com')) && !tag('a@x.com').includes('x.com') && tag('') === '', 'ownerTag: normalised, distinguishes signers, does not contain the address, empty -> empty');
ok(!!PR && typeof PR.readCtx === 'function', 'PartnerRegistration.readCtx loaded');
const mk = (owner) => ({ getItem: () => JSON.stringify({ ts: Date.now(), ...(owner === undefined ? {} : { owner }), agentType: 're_agent', attribution: { p_utm_source: 'x' } }) });
ok(PR.readCtx(mk(tag('a@x.com')), undefined, tag(' A@X.com'))?.agentType === 're_agent', 'same owner (case/space-insensitive): ctx honoured');
ok(PR.readCtx(mk(tag('a@x.com')), undefined, tag('b@x.com')) === null, 'FOREIGN owner: ctx ignored');
ok(PR.readCtx(mk(undefined), undefined, tag('a@x.com')) === null, 'legacy ownerless ctx + signed-in tag: ignored');
ok(PR.readCtx(mk(undefined))?.agentType === 're_agent', 'no tag supplied: legacy behaviour unchanged');
const dash = fs.readFileSync(path.join(ROOT, 'partner-dashboard.html'), 'utf8');
ok(/PR\.readCtx\(localStorage, undefined, .*Auth\.ownerTag\(currentUser\.email\)/.test(dash), 'partner-dashboard passes the signed-in owner tag to readCtx');
// ---- gh-2344 LEGAL-READ FAIL 5965145560 / CEO ruling #2304 5965155761 item 1: a DROPPED signup ctx (missing or different
// owner) makes the dashboard re-collect ASK for partner type + recruiter code; it never defaults to 'other' / the standard
// Partner Terms. Drives the REAL renderPartnerRecollect + js/partner-registration.js + js/agent-types.js + Auth.ownerTag in a vm.
{
  const extractFn = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i === -1) return null; let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } } return null; };
  const recSrc = extractFn(dash, 'renderPartnerRecollect');
  ok(!!recSrc, 'partner-dashboard defines renderPartnerRecollect');
  ok(!/agentType\s*=\s*\(ctx && ctx\.agentType\)\s*\|\|\s*'other'/.test(dash), "re-collect has no `|| 'other'` default for a dropped ctx");
  ok(!!PR && PR.buildRecollectParams(undefined, { first: 'A', last: 'B', phone: '1' }, null, 'a@x.com', false, Date.now()) === null, "buildRecollectParams: no type -> null (no silent 'other')");
  const libSrc = fs.readFileSync(path.join(ROOT, 'js', 'partner-registration.js'), 'utf8');
  const typesSrc = fs.readFileSync(path.join(ROOT, 'js', 'agent-types.js'), 'utf8');
  const OWN = 'legit-partner@example.invalid';
  const store = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const mkNode = (tag) => { const n = { tag, style: {}, children: [], _l: {}, value: '', checked: false, appendChild(c) { n.children.push(c); return c; }, addEventListener(t, f) { (n._l[t] = n._l[t] || []).push(f); } };
    Object.defineProperty(n, 'textContent', { get() { return n._t || ''; }, set(v) { n._t = v; n.children = []; } }); return n; };
  const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  async function run({ ctx, pick, recruitTyped, values, recruiters = { 'r-ABC123': { id: 'rec1', first_name: 'Pat', last_name: 'Recruiter', company: 'PR Co' } }, lookupError = false }) {
    const local = store(); if (ctx) local.setItem('oq_partner_signup_ctx', JSON.stringify(ctx));
    const els = new Map(); const rpcCalls = []; const lookups = []; const alerts = []; let reloads = 0;
    const doc = { getElementById(id) { if (!els.has(id)) els.set(id, mkNode('div')); return els.get(id); }, createElement: (t) => mkNode(t), createTextNode: (t) => ({ text: t, children: [] }) };
    const sb = { rpc(name, params) {
      if (name === 'get_referral_agents_public') { const f = {}; const b = { select() { return b; }, eq(k, v) { f[k] = v; return b; }, maybeSingle: async () => { lookups.push(f); if (lookupError) return { data: null, error: { message: 'network' } }; return { data: recruiters[f.recruit_code] && f.status === 'active' ? recruiters[f.recruit_code] : null, error: null }; } }; return b; }
      rpcCalls.push({ name, params }); return Promise.resolve({ error: null }); } };
    const win = { location: { reload() { reloads++; } } }; win.window = win;
    const c = { window: win, document: doc, localStorage: local, sessionStorage: store(), sb, currentUser: { id: 'u1', email: OWN }, console: { error() {}, log() {}, warn() {} }, alert: (m) => alerts.push(String(m)), JSON, Date, String, Promise, Object, isFinite };
    vm.createContext(c); vm.runInContext(libSrc, c); vm.runInContext(typesSrc, c);
    win.Auth = { isTestEmail: () => false, ownerTag: Auth.ownerTag }; c.Auth = win.Auth; c.PartnerRegistration = win.PartnerRegistration; c.AgentTypes = win.AgentTypes;
    vm.runInContext(recSrc + '\n;this.__rec = renderPartnerRecollect;', c);
    c.__rec(); await tick();
    const host = doc.getElementById('partnerRecollect');
    const find = (id) => { let hit = null; walk(host, (n) => { if (!hit && n.id === id) hit = n; }); return hit; };
    const out = { rpcCalls, lookups, alerts, host, find, askShown: !!find('partnerRecollect_agentType'), formBeforePick: !!find('partnerRecollectForm'), reloads: () => reloads };
    const sel = find('partnerRecollect_agentType');
    out.options = sel ? sel.children.map((o) => ({ value: o.value, text: (o.children[0] || {}).text, selected: !!o.selected })) : [];
    if (sel && pick) { sel.value = pick; (sel._l.change || []).forEach((f) => f({})); }
    const rc = find('partnerRecollect_recruitCode'); if (rc && recruitTyped !== undefined) rc.value = recruitTyped;
    const form = find('partnerRecollectForm');
    out.termsLinks = []; if (form) walk(form, (n) => { if (n.tag === 'a') out.termsLinks.push(n.href); });
    if (form && values) {
      for (const [k, v] of Object.entries(values)) { const n = find('partnerRecollect_' + k); if (n) n.value = v; }
      find('partnerRecollect_terms').checked = true;
      (form._l.submit || []).forEach((f) => f({ preventDefault() {} })); await tick();
    }
    return out;
  }
  const V = { first: 'Jane', last: 'Smith', phone: '3175551234', company: 'Acme Inspections' };
  const legacyCtx = { ts: Date.now(), agentType: 'home_inspector', attribution: { p_recruit_code: 'r-CTX111', p_utm_source: 'facebook' } }; // owner-less: written by main before this PR
  // (a) dropped ctx (missing owner) -> the ask is shown, nothing preselected, no form/agreement, no register_partner
  let r = await run({ ctx: legacyCtx });
  ok(r.askShown && !r.formBeforePick, '(a) owner-less ctx dropped -> partner-type ask shown, no form (no agreement) until a type is picked');
  ok(r.options.length === 6 && r.options[0].value === '' && r.options[0].selected && !r.options.some((o) => o.value === 'other' && o.selected), '(a) no type preselected (never "other" by default) -- ' + JSON.stringify(r.options.map((o) => o.value)));
  ok(r.options.slice(1).map((o) => o.text).join('|') === 'Real Estate Agent|Insurance Agent|Home Inspector|Insurance Adjuster|Other', '(a) options are AgentTypes.CHOOSER_LABELS (the signup chooser labels)');
  ok(!!r.find('partnerRecollect_recruitCode'), '(a) recruiter code field shown');
  ok(r.rpcCalls.length === 0, '(a) register_partner not called before a type is picked');
  // (a2) submit attempt with no pick: there is no form to submit -> still nothing registered as other
  r = await run({ ctx: legacyCtx, values: V });
  ok(r.rpcCalls.length === 0, '(a2) filling without picking a type cannot register (no "other" default)');
  // (b) foreign owner -> ask
  r = await run({ ctx: { ...legacyCtx, owner: tag('someone-else@example.invalid') } });
  ok(r.askShown && !r.formBeforePick && r.rpcCalls.length === 0, '(b) different-owner ctx dropped -> ask shown, no register_partner');
  // (c) pick home_inspector + recruit code typed (case-folded) -> that type's agreement, recruiter credited, ctx recruit NOT used
  r = await run({ ctx: legacyCtx, pick: 'home_inspector', recruitTyped: ' R-abc123 ', values: V });
  ok(r.termsLinks.includes('partner-agreement-inspector.html') && !r.termsLinks.includes('partner-agreement.html'), '(c) picking Home Inspector selects partner-agreement-inspector.html, not the standard Partner Terms -- ' + JSON.stringify(r.termsLinks));
  const pc = r.rpcCalls[0] && r.rpcCalls[0].params;
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].name === 'register_partner' && pc.p_agent_type === 'home_inspector', '(c) register_partner with the PICKED type home_inspector');
  ok(!!pc && pc.p_recruit_code === 'r-ABC123' && r.lookups.length === 1 && r.lookups[0].recruit_code === 'r-ABC123' && r.lookups[0].status === 'active', '(c) typed recruiter code normalised, looked up (active), and credited');
  ok(!!pc && pc.p_referred_by_note === 'Pat Recruiter', '(c) valid code: p_referred_by_note = the recruiter display name, as partner-other/partner-adjusters send it (detectRecruitCode fills the field with it) -- ' + JSON.stringify(pc && pc.p_referred_by_note));
  ok(!!pc && pc.p_utm_source === null && pc.p_recruit_code !== 'r-CTX111', '(c) nothing from the dropped ctx is used');
  // (d) pasted recruit link is accepted
  r = await run({ ctx: null, pick: 're_agent', recruitTyped: 'https://otterquote.com/recruit.html?code=r-ABC123', values: V });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_agent_type === 're_agent' && r.rpcCalls[0].params.p_recruit_code === 'r-ABC123', '(d) no ctx at all -> ask; pasted recruit link credited');
  // (e) unknown code -> not credited (as on the signup pages); empty -> not credited
  r = await run({ ctx: legacyCtx, pick: 'adjuster', recruitTyped: 'r-NOPE99', values: V });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_recruit_code === null && r.rpcCalls[0].params.p_agent_type === 'adjuster', '(e) unknown recruit code: registered as the picked type, not credited');
  ok(r.rpcCalls[0] && r.rpcCalls[0].params.p_referred_by_note === 'r-NOPE99', '(e) unknown code text kept as p_referred_by_note');
  r = await run({ ctx: legacyCtx, pick: 'home_inspector', recruitTyped: '  Jane Smith  ', values: V });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_referred_by_note === 'Jane Smith' && r.rpcCalls[0].params.p_recruit_code === null, '(e) a typed NAME is sent as p_referred_by_note (trimmed), not credited -- as on partner-other/partner-adjusters');
  ok(r.find('partnerRecollect_recruitCode').placeholder === 'Name or company of the person who recommended Otter Quotes' && fs.readFileSync(path.join(ROOT, 'partner-other.html'), 'utf8').includes('placeholder="Name or company of the person who recommended Otter Quotes"'), '(e) field placeholder verbatim from partner-other.html');
  r = await run({ ctx: legacyCtx, pick: 'other', recruitTyped: '', values: V });
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_agent_type === 'other' && r.rpcCalls[0].params.p_recruit_code === null && !('p_referred_by_note' in r.rpcCalls[0].params) && r.lookups.length === 0, '(e) "other" only when explicitly picked; empty field -> no lookup, neither code nor note sent');
  // (f) lookup failure blocks the submit (never registers uncredited by accident)
  r = await run({ ctx: legacyCtx, pick: 'home_inspector', recruitTyped: 'r-ABC123', values: V, lookupError: true });
  ok(r.rpcCalls.length === 0 && r.alerts.includes(PR.ERR_TEXT), '(f) recruit lookup error: no register_partner, page error text shown');
  // (g) owner-matching ctx -> unchanged path: no ask, ctx type + ctx recruit code
  r = await run({ ctx: { ...legacyCtx, owner: tag(OWN), agentType: 'adjuster' }, values: V });
  ok(!r.askShown && r.formBeforePick, '(g) owner-matching ctx: no ask, the form is shown directly');
  ok(r.rpcCalls.length === 1 && r.rpcCalls[0].params.p_agent_type === 'adjuster' && r.rpcCalls[0].params.p_recruit_code === 'r-CTX111' && r.rpcCalls[0].params.p_utm_source === 'facebook' && r.lookups.length === 0 && !('p_referred_by_note' in r.rpcCalls[0].params), '(g) owner-matching ctx: type + recruit code + UTM from the ctx (unchanged, no note key)');
}
console.log(fail ? ('\n' + fail + ' check(s) FAILED') : '\nOK: gh-2344 partner-site owner stamp + ctx binding + dropped-ctx ask proven.');
process.exit(fail ? 1 : 0);
