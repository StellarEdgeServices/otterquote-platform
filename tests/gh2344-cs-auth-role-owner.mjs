/**
 * gh-2344 -- static stack: the `cs_auth_role` breadcrumb is bound to its signer.
 *
 * The 24h TTL bounds the breadcrumb's AGE but not who it is for. A stranger's
 * abandoned `cs_auth_role='contractor'` steered the NEXT person's post-login
 * routing (and made js/auth.js skip that person's homeowner cs_signup profile
 * write). Fix: the writer stores the signer's normalised email in
 * `cs_auth_role_email`; every reader honours the breadcrumb only when that
 * equals the signed-in user's email, otherwise ignores it AND clears all keys.
 * A legacy breadcrumb with no owner is foreign. Google OAuth writers do not know
 * the email, so they bind to the tab: `oauth-tab:<nonce>` + sessionStorage nonce.
 *
 * Covers the three static readers, each executed for real in a vm:
 *   js/auth.js  Auth.handleAuthCallback()
 *   auth-callback.html  _oqGetIntent() routing IIFE
 *   index.html  hash-bounce IIFE
 *
 * NEGATIVE CONTROL (foreign cases must FAIL on origin/main):
 *   mkdir -p /tmp/main/js && git show origin/main:js/auth.js > /tmp/main/js/auth.js \
 *     && git show origin/main:auth-callback.html > /tmp/main/auth-callback.html \
 *     && git show origin/main:index.html > /tmp/main/index.html
 *   node tests/gh2344-cs-auth-role-owner.mjs /tmp/main
 * GREEN: node tests/gh2344-cs-auth-role-owner.mjs
 *
 * Run: node tests/gh2344-cs-auth-role-owner.mjs [rootDir]. Exit 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const authSrc = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
const callbackHtml = fs.readFileSync(path.join(ROOT, 'auth-callback.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const cbMatch = callbackHtml.match(/<script>\n\(function \(\) \{\n {2}'use strict';[\s\S]*?\n\}\)\(\);\n<\/script>/);
const ixMatch = indexHtml.match(/<script>\s*\n\(function \(\) \{[\s\S]*?\}\)\(\);\s*\n<\/script>/);
assert.ok(cbMatch && ixMatch, 'could not locate the routing IIFEs');
const callbackSrc = cbMatch[0].replace(/^<script>\n/, '').replace(/\n<\/script>$/, '');
const bounceSrc = ixMatch[0].replace(/^<script>\s*\n/, '').replace(/\n<\/script>$/, '');

const ME = 'user@example.com';
const STRANGER = 'stranger@example.com';
const KEYS = ['cs_auth_role', 'cs_auth_role_at', 'cs_auth_role_email'];

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

/** Seed a breadcrumb. `owner`: string (stored as-is), or undefined for a legacy owner-less breadcrumb. */
function seed(ls, role, owner, at = Date.now()) {
  ls.setItem('cs_auth_role', role);
  ls.setItem('cs_auth_role_at', String(at));
  if (owner !== undefined) ls.setItem('cs_auth_role_email', owner);
}

function assertCleared(ls, ss) {
  for (const k of KEYS) assert.equal(ls.getItem(k), null, `${k} was not cleared`);
  assert.equal(ss.getItem('cs_auth_role_tab'), null, 'cs_auth_role_tab was not cleared');
}

// ---------- reader 1: js/auth.js handleAuthCallback ----------
function makeAuth(sessionInit = {}) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage(sessionInit);
  const calls = { profileUpsert: null };
  const sandbox = {
    console: { ...console, warn: () => {} },
    setTimeout, clearTimeout, Promise, localStorage, sessionStorage,
    document: { cookie: '' }, navigator: { userAgent: 'node-test' },
    window: { location: { pathname: '/auth-callback.html', href: '' }, OtterQuoteReferral: undefined },
  };
  const tableQuery = (table) => {
    const q = {
      select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
      upsert(p) { if (table === 'profiles') calls.profileUpsert = p; return q; },
      single() {
        if (table === 'contractors') return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        if (table === 'resolved_user_role') return Promise.resolve({ data: { derived_role: 'homeowner' }, error: null });
        if (table === 'claims') return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        if (table === 'profiles') return Promise.resolve({ data: { id: 'u1', ...(calls.profileUpsert || {}) }, error: null });
        throw new Error('unexpected table ' + table);
      },
    };
    return q;
  };
  sandbox.sb = { from: tableQuery, rpc: () => Promise.resolve({ data: { claimed: false }, error: null }), auth: { signOut: async () => ({ error: null }) } };
  sandbox.window.sb = sandbox.sb;
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
  sandbox.window.Auth.getUser = async () => ({ id: 'u1', email: ME });
  return { Auth: sandbox.window.Auth, localStorage, sessionStorage, calls };
}
const signup = JSON.stringify({ first_name: 'Jamie', last_name: 'Rivera', phone: '555-0100', address: '12 Otter Way', role: 'homeowner' });

// ---------- reader 2: auth-callback.html ----------
async function runCallback(seedFn, sessionInit = {}) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage(sessionInit);
  seedFn(localStorage);
  const hrefWrites = [];
  let cb;
  // Real js/auth.js owner check bound to this run's storage (absent on origin/main -> no-op true).
  const a = makeAuth();
  const real = a.Auth.roleOwnerMatches ? (e) => {
    a.localStorage.setItem('cs_auth_role_email', localStorage.getItem('cs_auth_role_email') || '');
    if (!localStorage.getItem('cs_auth_role_email')) a.localStorage.removeItem('cs_auth_role_email');
    for (const k of ['cs_auth_role_tab']) { const v = sessionStorage.getItem(k); if (v) a.sessionStorage.setItem(k, v); }
    return a.Auth.roleOwnerMatches(e);
  } : () => true;
  const sandbox = {
    console: { ...console, log: () => {}, warn: () => {} }, setTimeout: () => {}, Promise, URLSearchParams,
    localStorage, sessionStorage, document: { getElementById: () => ({ style: {} }) }, gtag: () => {},
    window: { location: { search: '', get href() { return hrefWrites[hrefWrites.length - 1] ?? ''; }, set href(v) { hrefWrites.push(v); } }, _oq_has_auth_in_url: false },
    Auth: { recordFirstTouchAttribution: async () => {}, getRole: async () => 'homeowner', _getIsAdmin: async () => false, roleOwnerMatches: real },
  };
  sandbox.window.localStorage = localStorage;
  const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); } };
  sandbox.sb = { auth: { onAuthStateChange: (f) => { cb = f; } }, from: () => q };
  sandbox.window.sb = sandbox.sb;
  vm.createContext(sandbox);
  vm.runInContext(callbackSrc, sandbox, { filename: 'auth-callback.html#routing' });
  await cb('SIGNED_IN', { user: { id: 'u1', email: ME } });
  return { dest: hrefWrites[0] ?? null, localStorage, sessionStorage };
}

// ---------- reader 3: index.html bounce ----------
function runBounce(seedFn, sessionInit = {}, jwtEmail = ME) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', ...(jwtEmail ? { email: jwtEmail } : {}), user_metadata: {} })).toString('base64url');
  const hash = `#access_token=${header}.${payload}.sig&token_type=bearer`;
  const localStorage = makeStorage();
  const sessionStorage = makeStorage(sessionInit);
  seedFn(localStorage);
  let to = null;
  const sandbox = {
    console: { ...console, log: () => {} }, URLSearchParams, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage, sessionStorage, window: { location: { hash, search: '', replace: (u) => { to = u; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(bounceSrc, sandbox, { filename: 'index.html#bounce' });
  return { to, localStorage, sessionStorage };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✓ PASS: ${name}`); } catch (err) { failures += 1; console.log(`✗ FAIL: ${name}\n  ${err.message}`); }
}

// ===== js/auth.js =====
await check('js/auth.js: foreign-email cs_auth_role=contractor is ignored and cleared (homeowner profile write NOT swallowed)', async () => {
  const { Auth, localStorage, sessionStorage, calls } = makeAuth();
  seed(localStorage, 'contractor', STRANGER);
  localStorage.setItem('cs_signup', signup);
  await Auth.handleAuthCallback();
  assert.notEqual(calls.profileUpsert, null, 'a stranger\'s contractor breadcrumb steered routing: the signed-in user\'s homeowner profile write was skipped');
  assertCleared(localStorage, sessionStorage);
});
await check('js/auth.js: legacy owner-less cs_auth_role=contractor is treated as foreign (ignored and cleared)', async () => {
  const { Auth, localStorage, sessionStorage, calls } = makeAuth();
  seed(localStorage, 'contractor', undefined);
  localStorage.setItem('cs_signup', signup);
  await Auth.handleAuthCallback();
  assert.notEqual(calls.profileUpsert, null, 'an owner-less breadcrumb steered routing');
  assertCleared(localStorage, sessionStorage);
});
await check('js/auth.js: POSITIVE CONTROL same-email (case/space-insensitive) cs_auth_role=contractor still routes as contractor and is consumed', async () => {
  const { Auth, localStorage, sessionStorage, calls } = makeAuth();
  seed(localStorage, 'contractor', '  USER@Example.com ');
  localStorage.setItem('cs_signup', signup);
  await Auth.handleAuthCallback();
  assert.equal(calls.profileUpsert, null, 'same-signer contractor breadcrumb no longer honoured');
  assertCleared(localStorage, sessionStorage);
});
await check('js/auth.js: OAuth tab-bound breadcrumb honoured only in the tab that wrote it', async () => {
  // Same tab (nonce matches): honoured.
  let x = makeAuth({ cs_auth_role_tab: 'n0nce' });
  seed(x.localStorage, 'contractor', 'oauth-tab:n0nce');
  x.localStorage.setItem('cs_signup', signup);
  await x.Auth.handleAuthCallback();
  assert.equal(x.calls.profileUpsert, null, 'same-tab OAuth breadcrumb was not honoured');
  // Another tab / stranger left it (no nonce in this tab's sessionStorage): foreign.
  x = makeAuth({});
  seed(x.localStorage, 'contractor', 'oauth-tab:n0nce');
  x.localStorage.setItem('cs_signup', signup);
  await x.Auth.handleAuthCallback();
  assert.notEqual(x.calls.profileUpsert, null, 'another tab\'s OAuth breadcrumb steered routing');
  assertCleared(x.localStorage, x.sessionStorage);
});

// ===== auth-callback.html =====
await check('auth-callback.html: foreign-email cs_auth_role=contractor does not route to /contractor-pre-approval.html; cleared', async () => {
  const r = await runCallback((ls) => seed(ls, 'contractor', STRANGER));
  assert.notEqual(r.dest, '/contractor-pre-approval.html', 'a stranger\'s contractor breadcrumb steered routing to the contractor wizard');
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('auth-callback.html: legacy owner-less breadcrumb is ignored and cleared', async () => {
  const r = await runCallback((ls) => seed(ls, 'contractor', undefined));
  assert.notEqual(r.dest, '/contractor-pre-approval.html', 'an owner-less breadcrumb steered routing');
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('auth-callback.html: POSITIVE CONTROL same-email cs_auth_role=contractor still routes to /contractor-pre-approval.html', async () => {
  const r = await runCallback((ls) => seed(ls, 'contractor', ME));
  assert.equal(r.dest, '/contractor-pre-approval.html');
  assertCleared(r.localStorage, r.sessionStorage);
});

// ===== index.html =====
await check('index.html: foreign-email cs_auth_role=contractor does not bounce to /contractor-pre-approval.html; cleared', async () => {
  const r = runBounce((ls) => seed(ls, 'contractor', STRANGER));
  assert.equal(r.to, null, 'a stranger\'s contractor breadcrumb bounced this sign-in to ' + r.to);
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('index.html: foreign-email partner-role breadcrumb does not bounce to /partner-dashboard.html; cleared', async () => {
  const r = runBounce((ls) => seed(ls, 'home_inspector', STRANGER));
  assert.equal(r.to, null, 'a stranger\'s partner breadcrumb bounced this sign-in to ' + r.to);
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('index.html: legacy owner-less breadcrumb is ignored and cleared', async () => {
  const r = runBounce((ls) => seed(ls, 'contractor', undefined));
  assert.equal(r.to, null, 'an owner-less breadcrumb bounced this sign-in to ' + r.to);
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('index.html: POSITIVE CONTROL same-email cs_auth_role=contractor still bounces to /contractor-pre-approval.html', async () => {
  const r = runBounce((ls) => seed(ls, 'contractor', ME));
  assert.ok(r.to && r.to.startsWith('/contractor-pre-approval.html'), 'same-signer breadcrumb no longer bounces, got ' + r.to);
  assertCleared(r.localStorage, r.sessionStorage);
});
await check('index.html: expired (>24h) same-email breadcrumb is still ignored (TTL kept)', async () => {
  const r = runBounce((ls) => seed(ls, 'contractor', ME, Date.now() - 25 * 3600 * 1000));
  assert.equal(r.to, null);
  assertCleared(r.localStorage, r.sessionStorage);
});

if (failures) { console.log(`\n✗ ${failures} case(s) failed.`); process.exit(1); }
console.log('\n✓ All gh-2344 static cs_auth_role owner cases pass.');
