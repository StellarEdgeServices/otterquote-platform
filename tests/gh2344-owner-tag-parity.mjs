/**
 * gh-2344 follow-up: cs_auth_role_email holds a ONE-WAY TAG of the signer's email, never the address.
 * Three byte-copies of the cyrb53 tag exist (js/auth.js Auth.ownerTag, react-app lib/role-breadcrumb-owner.ts,
 * the inline reader in index.html); a drift between them silently misroutes users, so they are pinned here.
 * Negative controls: mutate one constant in each copy -> the parity check must FAIL.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.log('FAIL: ' + m); } };

const authSrc = read('js/auth.js');
const tsSrc = read('react-app/app/lib/role-breadcrumb-owner.ts');
const idxSrc = read('index.html');

function authFn(src) {
  const m = src.match(/  ownerTag\(email\) \{[\s\S]*?\n  \},\n/);
  if (!m) return null;
  return vm.runInNewContext('({' + m[0].replace(/,\s*$/, '') + '})').ownerTag;
}
function tsFn(src) {
  const m = src.match(/export function ownerTag\(email: unknown\): string \{[\s\S]*?\n\}\n/);
  if (!m) return null;
  const js = m[0].replace('export ', '').replace('(email: unknown): string', '(email)');
  return vm.runInNewContext('(function(){ const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : ""); ' + js + ' return ownerTag; })()');
}
function idxFn(src) {
  const m = src.match(/var _h1 = 0xdeadbeef[\s\S]*?lsOwnerOk = !!_em && _own === ([^;]+);/);
  if (!m) return null;
  const body = m[0].replace(/lsOwnerOk = !!_em && _own === ([^;]+);/, 'return $1;');
  return vm.runInNewContext('(function(_em){ ' + body + ' })');
}

const EMAILS = ['jane@example.com', 'pro@roofco.com', 'a@b.co', 'first.last+tag@sub.domain.org', 'user@example.com'];
const norm = (v) => v.trim().toLowerCase();
const copies = { 'js/auth.js': authFn(authSrc), 'role-breadcrumb-owner.ts': tsFn(tsSrc), 'index.html inline': idxFn(idxSrc) };
for (const [n, f] of Object.entries(copies)) ok(typeof f === 'function', n + ': tag copy located and evaluable');

const ref = copies['js/auth.js'];
function parity(fns) {
  return EMAILS.every((e) => Object.values(fns).every((f) => f && f(norm(e)) === ref(e)));
}
ok(parity(copies), 'all three cyrb53 copies agree on 5 sample emails');
ok(EMAILS.every((e) => /^o1:[0-9a-z]+$/.test(ref(e)) && !ref(e).includes('@')), 'tag has the o1: shape and never contains an @');
ok(new Set(EMAILS.map(ref)).size === EMAILS.length, 'the 5 sample emails produce 5 distinct tags');
ok(ref('  Jane@Example.COM ') === ref('jane@example.com'), 'tag is case- and whitespace-insensitive (normalised)');

// negative controls: a one-constant drift in any single copy must break parity
const mut = (s) => s.replace('2246822507', '2246822509');
const drifted = {
  'js/auth.js': authFn(mut(authSrc)),
  'role-breadcrumb-owner.ts': tsFn(mut(tsSrc)),
  'index.html inline': idxFn(mut(idxSrc)),
};
for (const [n, f] of Object.entries(drifted)) {
  const fns = { ...copies, [n]: f };
  ok(!parity(fns), 'NEGATIVE CONTROL: a drifted constant in ' + n + ' fails the parity check');
}

// no clear-text address in storage: run the REAL js/auth.js stampRoleOwner against a stub storage
const sm = authSrc.match(/  stampRoleOwner\(email\) \{[\s\S]*?\n  \},\n/);
const om = authSrc.match(/  ownerTag\(email\) \{[\s\S]*?\n  \},\n/);
function stampInto(email, stampSrc) {
  const store = {}, sess = {};
  const mk = (o) => ({ getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); }, removeItem: (k) => { delete o[k]; } });
  const A = vm.runInNewContext('({' + stampSrc + om[0] + '})', { localStorage: mk(store), sessionStorage: mk(sess), Math, Date });
  A.stampRoleOwner(email);
  return { store, sess };
}
for (const e of EMAILS) {
  const { store } = stampInto(e, sm[0]);
  ok(store.cs_auth_role_email === ref(e), 'stampRoleOwner(' + e.split('@')[1] + ') stores ownerTag(email)');
  ok(Object.values(store).every((v) => !v.includes('@')), 'no value in localStorage contains an @ after stampRoleOwner');
}
{
  const { store, sess } = stampInto(null, sm[0]);
  ok(/^oauth-tab:/.test(store.cs_auth_role_email) && store.cs_auth_role_email === 'oauth-tab:' + sess.cs_auth_role_tab, 'oauth-tab: owner form is unchanged');
}
// negative control for the storage check: the pre-change helper (stores the raw address) must be caught
{
  const { store } = stampInto('jane@example.com', sm[0].replace('this.ownerTag(e)', 'e'));
  ok(Object.values(store).some((v) => v.includes('@')), 'NEGATIVE CONTROL: a helper storing the raw address is detected by the @ check');
}

console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
console.log('OK: gh-2344 owner tag parity + no-clear-text-email proven.');
