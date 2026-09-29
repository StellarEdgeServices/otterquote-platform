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
console.log(fail ? ('\n' + fail + ' check(s) FAILED') : '\nOK: gh-2344 partner-site owner stamp + ctx binding proven.');
process.exit(fail ? 1 : 0);
