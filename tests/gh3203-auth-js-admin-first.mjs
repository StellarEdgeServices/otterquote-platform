/**
 * gh-3203 -- js/auth.js redirectToDashboard() (login.html password path) is admin-first.
 * Mirrors PR #3674 (react-app auth-callback): rpc('is_admin_email') is asked first and ONLY a
 * literal true with no error routes to https://app.otterquote.com/admin/contractors; an error,
 * a throw, null, false or any non-true value falls back to the existing role routing.
 * Runs the real js/auth.js in a vm context. Run: node tests/gh3203-auth-js-admin-first.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const authSrc = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
const ADMIN = 'https://app.otterquote.com/admin/contractors';

function sandboxFor({ rpc, pathname = '/login.html', contractor = false, saved = null }) {
  const writes = [];
  const location = { pathname, get href() { return pathname; }, set href(v) { writes.push(v); } };
  const q = (table) => ({
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    single() {
      if (table === 'resolved_user_role') return Promise.resolve({ data: { derived_role: contractor ? 'contractor' : 'homeowner' }, error: null });
      if (table === 'contractors') return Promise.resolve(contractor ? { data: { id: 'c1' }, error: null } : { data: null, error: { code: 'PGRST116' } });
      if (table === 'referral_agents' || table === 'claims') return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      if (table === 'profiles') return Promise.resolve({ data: { role: 'homeowner' }, error: null });
      throw new Error('unexpected table ' + table);
    },
  });
  const calls = [];
  const sb = { from: q, rpc: (n) => { calls.push(n); return rpc(n); } };
  const sandbox = {
    window: { location, sb }, console: { warn() {}, log() {}, error() {} }, setTimeout, Promise, sb,
    sessionStorage: { getItem: (k) => (k === 'cs_redirect' ? saved : null), setItem() {}, removeItem() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
  sandbox.window.Auth.getUser = async () => ({ id: 'u1' });
  return { sandbox, writes, calls };
}

const ok = (data) => async () => ({ data, error: null });
const CASES = [
  ['admin true + contractor row -> admin landing (THE FIX)', { rpc: ok(true), contractor: true }, ADMIN],
  ['admin true + stale contractor cs_redirect -> admin landing', { rpc: ok(true), contractor: true, saved: '/contractor-dashboard.html' }, ADMIN],
  ['admin true, homeowner -> admin landing', { rpc: ok(true) }, ADMIN],
  ['false -> existing routing (contractor dashboard)', { rpc: ok(false), contractor: true }, '/contractor-dashboard.html'],
  ['false, homeowner -> trade selector', { rpc: ok(false) }, '/trade-selector.html'],
  ['null -> existing routing', { rpc: ok(null), contractor: true }, '/contractor-dashboard.html'],
  ['string "true" is not true -> existing routing', { rpc: ok('true'), contractor: true }, '/contractor-dashboard.html'],
  ['1 is not true -> existing routing', { rpc: ok(1), contractor: true }, '/contractor-dashboard.html'],
  ['error WITH data true -> existing routing (!error hardening)', { rpc: async () => ({ data: true, error: { message: 'boom' } }), contractor: true }, '/contractor-dashboard.html'],
  ['rpc throws -> existing routing', { rpc: async () => { throw new Error('net'); }, contractor: true }, '/contractor-dashboard.html'],
  ['partner surface untouched even when admin (#643)', { rpc: ok(true), pathname: '/partner-dashboard.html', contractor: true }, null],
];

let failures = 0;
for (const [name, fx, expected] of CASES) {
  const { sandbox, writes } = sandboxFor(fx);
  await sandbox.window.Auth.redirectToDashboard();
  const got = writes[0] ?? null;
  try { assert.equal(got, expected); console.log('PASS: ' + name); }
  catch { failures++; console.error(`FAIL: ${name}\n    expected ${expected}\n    got ${got}`); }
}
{
  const { sandbox, calls } = sandboxFor({ rpc: ok(false) });
  await sandbox.window.Auth.redirectToDashboard();
  try { assert.deepEqual(calls, ['is_admin_email']); console.log('PASS: rpc is_admin_email is called'); }
  catch { failures++; console.error('FAIL: is_admin_email rpc not called, calls=' + JSON.stringify(calls)); }
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
