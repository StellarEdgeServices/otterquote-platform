/**
 * gh-2340 -- js/auth.js handleAuthCallback(): `cs_contractor_signup` applies only to its own signer.
 *
 * Pre-fix, handleAuthCallback() read the blob with no owner check, set
 * profiles.role='contractor' and inserted a contractors row for WHOEVER signed
 * in next on the browser (a stranger's abandoned signup promoted a homeowner).
 * Fix (Marty ruling 5881398936): honour the blob only when its stored email
 * equals the signed-in user's email AND its `_at` stamp is present, not future,
 * and under 24h; otherwise ignore + clear. Never promote a pre-existing
 * non-contractor account without a contractor-signup action in this session
 * (sessionStorage cs_contractor_signup_session).
 *
 * NEGATIVE CONTROL: run against origin/main's js/auth.js:
 *   git show origin/main:js/auth.js > /tmp/auth-main.js
 *   node tests/gh2340-contractor-signup-owner.mjs /tmp/auth-main.js   -> foreign-blob cases FAIL
 * GREEN: node tests/gh2340-contractor-signup-owner.mjs                 -> all PASS
 *
 * Run: node tests/gh2340-contractor-signup-owner.mjs [path/to/auth.js]. Exit 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'js', 'auth.js');
const authSrc = fs.readFileSync(authPath, 'utf8');

const DAY = 24 * 3600 * 1000;

function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

/**
 * Runs the real js/auth.js handleAuthCallback() in a vm sandbox with a mock `sb`.
 * `profileRole` is what profiles.role reads back for the user.
 */
function run({ blob, userEmail, userCreatedAt, profileRole = 'homeowner', sessionMarker = false, extraLs = {} }) {
  const ls = { ...extraLs };
  if (blob !== undefined) ls.cs_contractor_signup = JSON.stringify(blob);
  const localStorage = makeStorage(ls);
  const sessionStorage = makeStorage(sessionMarker ? { cs_contractor_signup_session: '1' } : {});
  const calls = { profileUpdate: null, contractorInsert: null, warnings: [] };
  const sandbox = {
    console: { ...console, warn: (...a) => calls.warnings.push(a.join(' ')) },
    setTimeout, clearTimeout, Promise, Date,
    localStorage, sessionStorage,
    document: { cookie: '' },
    navigator: { userAgent: 'node-test' },
    window: { location: { pathname: '/auth-callback.html', href: '' }, OtterQuoteReferral: undefined },
  };
  const table = (t) => {
    const q = {
      select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
      update(p) { if (t === 'profiles') calls.profileUpdate = p; return q; },
      upsert() { return q; },
      insert(p) { if (t === 'contractors') calls.contractorInsert = p; return q; },
      single() { return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } }); },
      maybeSingle() {
        if (t === 'profiles') return Promise.resolve({ data: { role: profileRole }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return q;
  };
  sandbox.sb = { from: table, rpc: () => Promise.resolve({ data: { claimed: false }, error: null }), auth: { signOut: async () => ({}) } };
  sandbox.window.sb = sandbox.sb;
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
  sandbox.window.Auth.getUser = async () => ({ id: 'user-2340', email: userEmail, created_at: userCreatedAt });
  return { sandbox, localStorage, sessionStorage, calls };
}

const blobFor = (email, at) => ({
  email, company_name: 'Stranger Roofing', contact_name: 'Sam Stranger', phone: '555-0100',
  role: 'contractor', onboarding_step: 1, ...(at === undefined ? {} : { _at: at }),
});
const iso = (ms) => new Date(ms).toISOString();

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (err) { failures += 1; console.log(`FAIL: ${name}\n  ${err.message}`); }
}
function assertNoPromotion(calls, localStorage) {
  assert.equal(calls.contractorInsert, null, 'a contractors row was inserted from the blob');
  assert.ok(!(calls.profileUpdate && calls.profileUpdate.role === 'contractor'), 'profiles.role was set to contractor from the blob');
  assert.equal(localStorage.getItem('cs_contractor_signup'), null, 'blob must be cleared');
  assert.equal(localStorage.getItem('cs_contractor_signup_at'), null, 'blob stamp key must be cleared');
}

const now = Date.now();
const longAgo = iso(now - 400 * DAY); // established homeowner account

await check('FOREIGN blob (different email, fresh stamp) + homeowner sign-in: no role change, no contractors insert, both keys cleared', async () => {
  const r = run({ blob: blobFor('stranger@example.com', now - 60000), userEmail: 'homeowner@example.com', userCreatedAt: longAgo, extraLs: { cs_contractor_signup_at: String(now - 60000) } });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

await check('FOREIGN blob for a brand-new homeowner account (created just now) is still ignored', async () => {
  const r = run({ blob: blobFor('stranger@example.com', now - 60000), userEmail: 'homeowner@example.com', userCreatedAt: iso(now) });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

await check('STALE stamp (>24h) for the SAME email: ignored and cleared', async () => {
  const r = run({ blob: blobFor('me@example.com', now - 25 * 3600 * 1000), userEmail: 'me@example.com', userCreatedAt: iso(now - 3600 * 1000) });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

await check('FUTURE-dated stamp for the SAME email: ignored and cleared', async () => {
  const r = run({ blob: blobFor('me@example.com', now + 3600 * 1000), userEmail: 'me@example.com', userCreatedAt: iso(now) });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

await check('MISSING stamp (pre-fix blob) for the SAME email: ignored and cleared', async () => {
  const r = run({ blob: blobFor('me@example.com'), userEmail: 'me@example.com', userCreatedAt: iso(now) });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

await check('rejection logs via console.warn only', async () => {
  const r = run({ blob: blobFor('stranger@example.com', now), userEmail: 'homeowner@example.com', userCreatedAt: longAgo });
  await r.sandbox.window.Auth.handleAuthCallback();
  assert.ok(r.calls.warnings.some((w) => w.includes('cs_contractor_signup')), 'expected a console.warn about the ignored blob');
});

await check('EXISTING homeowner, own email + fresh stamp, but NO same-session signup action: NOT promoted, blob cleared', async () => {
  const r = run({ blob: blobFor('me@example.com', now - 60000), userEmail: 'me@example.com', userCreatedAt: longAgo, profileRole: 'homeowner' });
  await r.sandbox.window.Auth.handleAuthCallback();
  assertNoPromotion(r.calls, r.localStorage);
});

// ---- positive controls: the matching-email case must still complete contractor signup ----
await check('POSITIVE: matching email + fresh stamp on a NEW account (profile default role=homeowner): role update + contractors insert + blob cleared', async () => {
  const r = run({ blob: blobFor('me@example.com', now - 60000), userEmail: 'ME@Example.com ', userCreatedAt: iso(now - 30000), profileRole: 'homeowner' });
  await r.sandbox.window.Auth.handleAuthCallback();
  assert.ok(r.calls.contractorInsert, 'expected a contractors insert');
  assert.equal(r.calls.contractorInsert.company_name, 'Stranger Roofing');
  assert.equal(r.calls.profileUpdate && r.calls.profileUpdate.role, 'contractor');
  assert.equal(r.localStorage.getItem('cs_contractor_signup'), null);
});

await check('POSITIVE: existing homeowner who ran contractor-join in THIS session (marker set) is promoted', async () => {
  const r = run({ blob: blobFor('me@example.com', now - 60000), userEmail: 'me@example.com', userCreatedAt: longAgo, profileRole: 'homeowner', sessionMarker: true });
  await r.sandbox.window.Auth.handleAuthCallback();
  assert.ok(r.calls.contractorInsert, 'expected a contractors insert');
  assert.equal(r.calls.profileUpdate && r.calls.profileUpdate.role, 'contractor');
  assert.equal(r.sessionStorage.getItem('cs_contractor_signup_session'), null, 'session marker must be cleared after use');
});

await check('POSITIVE: existing account whose profile role is already contractor completes signup', async () => {
  const r = run({ blob: blobFor('me@example.com', now - 60000), userEmail: 'me@example.com', userCreatedAt: longAgo, profileRole: 'contractor' });
  await r.sandbox.window.Auth.handleAuthCallback();
  assert.ok(r.calls.contractorInsert, 'expected a contractors insert');
});

await check('POSITIVE: stamp only in cs_contractor_signup_at key is accepted', async () => {
  const b = blobFor('me@example.com'); // no _at in blob
  const r = run({ blob: b, userEmail: 'me@example.com', userCreatedAt: iso(now - 30000), extraLs: { cs_contractor_signup_at: String(now - 60000) } });
  await r.sandbox.window.Auth.handleAuthCallback();
  assert.ok(r.calls.contractorInsert, 'expected a contractors insert');
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
