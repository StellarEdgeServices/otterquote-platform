/**
 * gh-2060 -- dirty-state coverage for the STATIC-stack storage surfaces that
 * live inline in root *.html pages and js/auth.js (the React-stack surfaces
 * are covered by vitest files that use seedStaleStorage(); see
 * tests/fixtures/gh2060-storage-surface-ledger.json for the full mapping).
 *
 * Every case seeds "what a previous visit / visitor / app version left
 * behind" into a fresh in-memory storage BEFORE running the real page code
 * (extracted from the shipped HTML, not re-implemented), then asserts the
 * correct behaviour.
 *
 * Surfaces covered here:
 *   cs_utm_context (14 partner/funnel pages, captureUtmContext)
 *   utm_params (landing.html)
 *   oq_variant_v3 (11 static readers, getOqVariant)
 *   oq_ft (js/auth.js recordFirstTouchAttribution)
 *   cs_contractor_signup (js/auth.js handleAuthCallback)      [CLOSED by gh-2340]
 *   cs_recruit_code (11 partner/funnel pages, detectRecruitCode) [KNOWN GAP]
 *   oq_cpa_redirect_guard (5 guard pages + dashboard clear)
 *
 * KNOWN GAP cases encode the recommended-default behaviour asked for in the
 * Q: comment posted on #2060 and are EXPECTED to fail against current
 * source (product/money decision pending). The harness reports them as
 * "KNOWN GAP" and exits 0; if one starts passing, the run FAILS so the case
 * gets flipped to a normal assertion (same idea as vitest's it.fails).
 *
 * Run: node tests/gh2060-static-surfaces-staleness.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

let failures = 0;
let passes = 0;
let knownGaps = 0;

async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`✗ FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

/** A case that encodes recommended-default behaviour not implemented yet (Q: on #2060). */
async function knownGap(name, fn) {
  let threw = false;
  let why = '';
  try {
    await fn();
  } catch (err) {
    threw = true;
    why = err && err.message ? err.message : String(err);
    // Only an ASSERTION failure counts as the gap -- a harness error must not masquerade as one.
    if (!(err instanceof assert.AssertionError)) {
      failures += 1;
      console.log(`✗ FAIL: known-gap case threw a non-assertion error (harness problem): ${name}
  ${why}`);
      return;
    }
  }
  if (threw) {
    knownGaps += 1;
    console.log(`⚠ KNOWN GAP (Q on #2060, expected to fail today): ${name}
    reason: ${why}`);
  } else {
    failures += 1;
    console.log(`✗ FAIL: KNOWN GAP CLOSED -- ${name} now passes; convert it to a normal check().`);
  }
}

function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

/** Extract `function <name>(...) { ... }` from source by brace matching (skips strings/comments). */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i += 1; i < src.length; i++) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const rootHtml = () => fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith('.html')).sort();

// ---------------------------------------------------------------------------
// cs_utm_context -- captureUtmContext() on every page that has one
// ---------------------------------------------------------------------------
function runCaptureUtm(fnSrc, { search = '', stored }) {
  const localStorage = makeStorage(stored === undefined ? {} : { cs_utm_context: stored });
  const sandbox = {
    window: { location: { search } },
    localStorage,
    URLSearchParams,
    console,
    utmContext: {},
    clarity: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\ncaptureUtmContext();`, sandbox, { filename: 'captureUtmContext' });
  return { ctx: sandbox.utmContext, localStorage };
}

const utmPages = rootHtml().filter((f) => read(f).includes('function captureUtmContext('));

await check('discovery: captureUtmContext exists on the 14 partner/funnel pages', () => {
  assert.ok(utmPages.length >= 14, `expected >= 14 pages, found ${utmPages.length}: ${utmPages.join(', ')}`);
});

const STALE_CTX = JSON.stringify({ source: 'old_source', medium: 'old_medium', campaign: 'old_campaign', funnelId: 'zz-9' });

for (const page of utmPages) {
  const fnSrc = extractFunction(read(page), 'captureUtmContext');
  // Pages that default the funnel id to their own (hi-*, ins-*, re-*) declare it in the function.
  const ownFunnel = (fnSrc.match(/utmContext\.funnelId\s*=\s*'([a-z]{2,4}-\d{1,3})'/) || [])[1] || null;

  await check(`${page}: a fresh ?utm_source= beats a stale stored context, and replaces it in storage`, () => {
    const { ctx, localStorage } = runCaptureUtm(fnSrc, { search: '?utm_source=fresh&utm_medium=cpc', stored: STALE_CTX });
    assert.equal(ctx.source, 'fresh');
    assert.equal(ctx.medium, 'cpc');
    assert.notEqual(ctx.campaign, 'old_campaign', 'stale campaign leaked into the fresh context');
    assert.equal(JSON.parse(localStorage.getItem('cs_utm_context')).source, 'fresh');
  });

  await check(`${page}: a malformed stale value is ignored (no throw, no source)`, () => {
    const { ctx } = runCaptureUtm(fnSrc, { search: '', stored: '{not json' });
    assert.ok(!ctx.source, `expected no source, got ${JSON.stringify(ctx)}`);
  });

  if (ownFunnel) {
    await check(`${page}: a funnel id stored by a DIFFERENT funnel page never survives -- this page's own id (${ownFunnel}) wins`, () => {
      const { ctx } = runCaptureUtm(fnSrc, { search: '', stored: STALE_CTX });
      assert.equal(ctx.funnelId, ownFunnel, `stale funnelId 'zz-9' survived: ${JSON.stringify(ctx)}`);
    });
    await check(`${page}: an explicit ?funnel_id= on this load still wins over the page default (positive control)`, () => {
      const { ctx } = runCaptureUtm(fnSrc, { search: '?funnel_id=explicit-1&utm_source=x', stored: STALE_CTX });
      assert.equal(ctx.funnelId, 'explicit-1');
    });
  } else {
    await check(`${page}: with no URL params the stored context is still used (sticky by design -- pinned)`, () => {
      const { ctx } = runCaptureUtm(fnSrc, { search: '', stored: STALE_CTX });
      assert.equal(ctx.source, 'old_source');
    });
  }
}

// ---------------------------------------------------------------------------
// utm_params -- landing.html getUTMParams() / buildGetStartedURL()
// ---------------------------------------------------------------------------
{
  const landing = read('landing.html');
  const getSrc = extractFunction(landing, 'getUTMParams');
  const buildSrc = extractFunction(landing, 'buildGetStartedURL');
  const run = (search, stored) => {
    const sessionStorage = makeStorage(stored === undefined ? {} : { utm_params: stored });
    const sandbox = { window: { location: { search } }, sessionStorage, URLSearchParams, JSON };
    vm.createContext(sandbox);
    vm.runInContext(`${getSrc}\n${buildSrc}`, sandbox);
    return { sandbox, sessionStorage };
  };
  const stale = JSON.stringify({ source: 'old_source', medium: 'old_medium', campaign: 'old_campaign', content: '', term: '', fbclid: 'OLDFBCLID', gclid: '' });

  await check('landing.html: a fresh landing (?utm_source=) overwrites the stale sessionStorage utm_params entirely', () => {
    const { sandbox, sessionStorage } = run('?utm_source=fresh', stale);
    vm.runInContext('getUTMParams()', sandbox);
    const stored = JSON.parse(sessionStorage.getItem('utm_params'));
    assert.equal(stored.source, 'fresh');
    assert.equal(stored.fbclid, '', 'stale click id leaked into the fresh landing');
    const url = vm.runInContext('buildGetStartedURL()', sandbox);
    assert.ok(url.includes('utm_source=fresh') && !url.includes('OLDFBCLID'), url);
  });

  await check('landing.html: a corrupt stale utm_params (older app version) does not break the CTA URL builder for a fresh landing', () => {
    const { sandbox } = run('?utm_source=fresh', '{oops');
    vm.runInContext('getUTMParams()', sandbox);
    assert.ok(vm.runInContext('buildGetStartedURL()', sandbox).includes('utm_source=fresh'));
  });

  await check('landing.html: with no URL params the CTA builder uses the stored params (same-tab carry -- pinned)', () => {
    const { sandbox } = run('', stale);
    const url = vm.runInContext('buildGetStartedURL()', sandbox);
    assert.ok(url.includes('utm_source=old_source'), url);
  });
}

// ---------------------------------------------------------------------------
// oq_variant_v3 -- getOqVariant() on every static reader
// ---------------------------------------------------------------------------
const variantPages = rootHtml().filter((f) => read(f).includes('function getOqVariant('));
await check('discovery: getOqVariant exists on the static partner/funnel pages', () => {
  assert.ok(variantPages.length >= 11, `expected >= 11, found ${variantPages.length}`);
});
for (const page of variantPages) {
  const fnSrc = extractFunction(read(page), 'getOqVariant');
  const run = ({ search = '', stored, cookie = '' }) => {
    const localStorage = makeStorage(stored === undefined ? {} : { oq_variant_v3: stored });
    const sandbox = {
      window: { location: { search }, localStorage },
      document: { cookie },
      URLSearchParams,
      RegExp,
      decodeURIComponent,
    };
    vm.createContext(sandbox);
    return vm.runInContext(`${fnSrc}\ngetOqVariant()`, sandbox);
  };
  const baseline = run({});
  await check(`${page}: a stale value of the wrong shape (older app version) is never forwarded`, () => {
    assert.equal(run({ stored: 'Legacy-Arm-Name!' }), baseline);
  });
  await check(`${page}: a fresh ?v= beats a different stale stored arm`, () => {
    assert.equal(run({ search: '?v=e', stored: 'b' }), 'e');
  });
  await check(`${page}: a valid stale arm is still reported when this load has no ?v= (sticky by design -- pinned)`, () => {
    assert.equal(run({ stored: 'd' }), 'd');
  });
}

// ---------------------------------------------------------------------------
// oq_ft -- js/auth.js recordFirstTouchAttribution()
// ---------------------------------------------------------------------------
{
  const authSrc = read('js/auth.js');
  const run = ({ ls, cookie = '' }) => {
    const localStorage = makeStorage(ls === undefined ? {} : { oq_ft: ls });
    const rpcArgs = [];
    const sandbox = {
      console, setTimeout, clearTimeout, Promise,
      localStorage, sessionStorage: makeStorage(),
      document: { cookie },
      navigator: { userAgent: 'node-test' },
      window: { location: { pathname: '/auth-callback.html', href: '' } },
      sb: null,
    };
    sandbox.sb = { rpc: (name, args) => { rpcArgs.push([name, args]); return Promise.resolve({ data: null, error: null }); } };
    sandbox.window.sb = sandbox.sb;
    vm.createContext(sandbox);
    vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
    return { sandbox, rpcArgs };
  };
  await check('js/auth.js: an unparsable oq_ft (stale/half-written) reads as no first touch -- RPC gets p_attr null, no throw', async () => {
    const { sandbox, rpcArgs } = run({ ls: '{not json' });
    await sandbox.window.Auth.recordFirstTouchAttribution();
    assert.equal(rpcArgs.length, 1);
    assert.equal(rpcArgs[0][1].p_attr, null);
  });
  await check('js/auth.js: a stale array-shaped oq_ft is rejected (only a plain object is sent)', async () => {
    const { sandbox, rpcArgs } = run({ ls: '[1,2,3]' });
    await sandbox.window.Auth.recordFirstTouchAttribution();
    assert.equal(rpcArgs[0][1].p_attr, null);
  });
  await check('js/auth.js: the cookie wins over a DIFFERENT stale localStorage first touch', async () => {
    const cookie = 'oq_ft=' + encodeURIComponent(JSON.stringify({ v: 1, utm_source: 'cookie_src', ts: '2026-09-01T00:00:00.000Z' }));
    const { sandbox, rpcArgs } = run({ ls: JSON.stringify({ v: 1, utm_source: 'stale_ls', ts: '2026-01-01T00:00:00.000Z' }), cookie });
    await sandbox.window.Auth.recordFirstTouchAttribution();
    assert.equal(rpcArgs[0][1].p_attr.utm_source, 'cookie_src');
  });
}

// ---------------------------------------------------------------------------
// cs_contractor_signup -- js/auth.js handleAuthCallback() (CLOSED by gh-2340 / PR #2343)
// ---------------------------------------------------------------------------
{
  const authSrc = read('js/auth.js');
  const run = ({ blob, userEmail }) => {
    const localStorage = makeStorage({ cs_contractor_signup: JSON.stringify(blob) });
    const calls = { profileUpdate: null, contractorInsert: null };
    const sandbox = {
      console, setTimeout, clearTimeout, Promise,
      localStorage, sessionStorage: makeStorage(),
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
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
      return q;
    };
    sandbox.sb = { from: table, rpc: () => Promise.resolve({ data: { claimed: false }, error: null }), auth: { signOut: async () => ({}) } };
    sandbox.window.sb = sandbox.sb;
    vm.createContext(sandbox);
    vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
    sandbox.window.Auth.getUser = async () => ({ id: 'user-gh2060', email: userEmail, created_at: new Date().toISOString() });
    return { sandbox, localStorage, calls };
  };
  // gh-2340: a blob is honoured only with a matching email AND a fresh `_at` (js/auth.js getOwnedContractorSignup).
  const blob = (email) => ({ email, company_name: 'Stranger Roofing', contact_name: 'Sam Stranger', phone: '555-0100', _at: Date.now() });

  await check('POSITIVE CONTROL: a signup blob for THIS user\'s own email creates the contractor row, promotes the role, and is cleared', async () => {
    const { sandbox, localStorage, calls } = run({ blob: blob('me@example.com'), userEmail: 'me@example.com' });
    await sandbox.window.Auth.handleAuthCallback();
    assert.ok(calls.contractorInsert, 'expected a contractors insert for the matching signup');
    assert.equal(calls.contractorInsert.company_name, 'Stranger Roofing');
    assert.equal(localStorage.getItem('cs_contractor_signup'), null, 'blob must be cleared after use');
  });

  await check('a stale cs_contractor_signup left by ANOTHER person (different email) does not create a contractor row or promote the signed-in user\'s role', async () => {
    const { sandbox, calls } = run({ blob: blob('stranger@example.com'), userEmail: 'homeowner@example.com' });
    await sandbox.window.Auth.handleAuthCallback();
    assert.ok(calls.contractorInsert === null, 'a stranger\'s company data was inserted as this user\'s contractor row');
    assert.notEqual(calls.profileUpdate && calls.profileUpdate.role, 'contractor', 'this user\'s profile was promoted to contractor from a stranger\'s blob');
  });
}

// ---------------------------------------------------------------------------
// cs_recruit_code -- detectRecruitCode() precedence on the partner/funnel pages (KNOWN GAP)
// ---------------------------------------------------------------------------
{
  const recruitPages = rootHtml().filter((f) => /localStorage\.getItem\('cs_recruit_code'\)/.test(read(f)));
  await check('discovery: cs_recruit_code is read on the partner/funnel pages', () => {
    assert.ok(recruitPages.length >= 11, `expected >= 11, found ${recruitPages.length}`);
  });
  for (const page of recruitPages) {
    const src = read(page);
    await check(`${page}: the recruit code is consumed (cleared) once a signup completes`, () => {
      assert.match(src, /localStorage\.removeItem\('cs_recruit_code'\)/);
    });
    await knownGap(`${page}: a ?recruit= on THIS load takes precedence over a stale stored recruit code`, () => {
      const m = src.match(/const recruitCode = ([^;]+);/);
      assert.ok(m, 'recruitCode assignment not found');
      assert.ok(
        m[1].indexOf("urlParams.get('recruit')") !== -1 &&
          m[1].indexOf("urlParams.get('recruit')") < m[1].indexOf("localStorage.getItem('cs_recruit_code')"),
        `stored value is consulted before the URL param: ${m[1].trim()}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// oq_cpa_redirect_guard -- static contractor guard pages + dashboard clear
// ---------------------------------------------------------------------------
{
  const guardPages = rootHtml().filter((f) => f !== 'contractor-dashboard.html' && /getItem\('oq_cpa_redirect_guard'\)/.test(read(f)));
  await check('discovery: oq_cpa_redirect_guard is read on the 5 non-dashboard contractor pages', () => {
    assert.ok(guardPages.length >= 5, `expected >= 5, found ${guardPages.join(', ')}`);
  });
  for (const page of guardPages) {
    await check(`${page}: the guard is only SET on the path that also redirects (never a free-floating stale flag)`, () => {
      const src = read(page);
      const idx = src.indexOf("localStorage.setItem('oq_cpa_redirect_guard'");
      assert.ok(idx > -1, 'guard writer not found');
      assert.ok(/window\.location\.href\s*=\s*'\/contractor-dashboard\.html'/.test(src.slice(idx, idx + 200)), 'guard set without the dashboard redirect');
      const before = src.slice(Math.max(0, idx - 400), idx);
      assert.ok(/cpa_version\s*!==\s*CURRENT_CPA_VERSION/.test(before), 'guard set without a stale-CPA condition');
    });
  }
  await check('contractor-dashboard.html: clears the guard when the CPA is current AND after re-acceptance', () => {
    const src = read('contractor-dashboard.html');
    const removes = src.match(/removeItem\('oq_cpa_redirect_guard'\)/g) || [];
    assert.ok(removes.length >= 2, `expected the clear on both the current-CPA branch and the re-accept path, found ${removes.length}`);
  });
}

// ---------------------------------------------------------------------------
// oq_nav_role / oq_nav_role_at -- js/nav.js explicit role-tab choice (30-min TTL)
// ---------------------------------------------------------------------------
{
  const navSrc = read('js/nav.js');
  const run = ({ role, at }) => {
    const seed = {};
    if (role !== undefined) seed.oq_nav_role = role;
    if (at !== undefined) seed.oq_nav_role_at = String(at);
    const sandbox = {
      console,
      window: { localStorage: makeStorage(seed), location: { pathname: '/index.html' } },
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${navSrc}\n;globalThis.__Nav = Nav;`, sandbox, { filename: 'js/nav.js' });
    return sandbox.__Nav;
  };
  await check('js/nav.js: an explicit role click older than 30 minutes no longer outranks the account role', () => {
    assert.equal(run({ role: 'contractor', at: Date.now() - 31 * 60 * 1000 })._explicitRoleChoice(), null);
  });
  await check('js/nav.js: a FUTURE-dated oq_nav_role_at (negative age) is not "fresh"', () => {
    assert.equal(run({ role: 'contractor', at: Date.now() + 24 * 60 * 60 * 1000 })._explicitRoleChoice(), null);
  });
  await check('js/nav.js: POSITIVE CONTROL -- a click 5 minutes ago still outranks the account role', () => {
    assert.equal(run({ role: 'contractor', at: Date.now() - 5 * 60 * 1000 })._explicitRoleChoice(), 'contractor');
  });
  await check('js/nav.js: a stored role with no timestamp (older app version) is not trusted as an explicit choice', () => {
    assert.equal(run({ role: 'contractor' })._explicitRoleChoice(), null);
  });
}

// ---------------------------------------------------------------------------
// cs_signup -- js/auth.js handleAuthCallback() homeowner profile write (KNOWN GAP)
// ---------------------------------------------------------------------------
{
  const authSrc = read('js/auth.js');
  const run = ({ ls }) => {
    const localStorage = makeStorage(ls);
    const calls = { profileUpsert: null };
    const sandbox = {
      console, setTimeout, clearTimeout, Promise,
      localStorage, sessionStorage: makeStorage(),
      document: { cookie: '' },
      navigator: { userAgent: 'node-test' },
      window: { location: { pathname: '/auth-callback.html', href: '' }, OtterQuoteReferral: undefined },
    };
    const table = (t) => {
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        upsert(p) { if (t === 'profiles') calls.profileUpsert = p; return q; },
        update() { return q; },
        single() {
          if (t === 'resolved_user_role') return Promise.resolve({ data: { derived_role: 'homeowner' }, error: null });
          if (t === 'profiles') return Promise.resolve({ data: { id: 'user-gh2060' }, error: null });
          return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
      return q;
    };
    sandbox.sb = { from: table, rpc: () => Promise.resolve({ data: { claimed: false }, error: null }), auth: { signOut: async () => ({}) } };
    sandbox.window.sb = sandbox.sb;
    vm.createContext(sandbox);
    vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
    sandbox.window.Auth.getUser = async () => ({ id: 'user-gh2060', email: 'me@example.com' });
    return { sandbox, calls, localStorage };
  };
  const signup = JSON.stringify({ first_name: 'Sam', last_name: 'Stranger', phone: '555-0100', address: '1 Stranger Way', role: 'homeowner' });

  await check('POSITIVE CONTROL: a fresh cs_signup (just written by get-started) is applied to the new homeowner profile and cleared', async () => {
    const { sandbox, calls, localStorage } = run({ ls: { cs_signup: signup, cs_signup_at: String(Date.now() - 60 * 1000), cs_auth_role: 'homeowner', cs_auth_role_at: String(Date.now()) } });
    await sandbox.window.Auth.handleAuthCallback();
    assert.ok(calls.profileUpsert, 'expected the profile write');
    assert.equal(localStorage.getItem('cs_signup'), null, 'cs_signup must be cleared after use');
  });

  await knownGap('a cs_signup older than 24h (abandoned signup by someone else on this browser) is not written to the new user\'s profile', async () => {
    const { sandbox, calls } = run({ ls: { cs_signup: signup, cs_signup_at: String(Date.now() - 25 * 60 * 60 * 1000) } });
    await sandbox.window.Auth.handleAuthCallback();
    assert.ok(calls.profileUpsert === null, 'a stale stranger cs_signup was written to this user\'s profile');
  });
}

// ---------------------------------------------------------------------------
// oq_partner_pending_registration -- email-keyed recovery marker (14 pages)
// ---------------------------------------------------------------------------
{
  const pages = rootHtml().filter((f) => read(f).includes("'oq_partner_pending_registration'"));
  await check('discovery: oq_partner_pending_registration is used on the 14 partner/funnel signup pages', () => {
    assert.ok(pages.length >= 14, `expected >= 14, found ${pages.length}`);
  });
  for (const page of pages) {
    await check(`${page}: the recovery marker is only honoured for the SAME email (a stale marker for anyone else is inert) and cleared on a definitive outcome`, () => {
      const src = read(page);
      assert.match(src, /pendingMarker\.email\s*===\s*emailKey/);
      assert.match(src, /removeItem\('oq_partner_pending_registration'\)/);
    });
  }
}

// ---------------------------------------------------------------------------
// oq_handout_hi4_contact / oq_handout_ins5_contact -- funnel -> handout PII handoff
// ---------------------------------------------------------------------------
for (const [file, key] of [['assets/handout-hi-4.html', 'oq_handout_hi4_contact'], ['assets/handout-ins-5.html', 'oq_handout_ins5_contact']]) {
  const html = read(file);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const scriptSrc = scripts.find((s) => s.includes(key));
  const runHandout = ({ search, stored }) => {
    const els = new Map();
    const el = (id) => {
      if (!els.has(id)) {
        els.set(id, { textContent: '', style: {}, children: [], appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
      }
      return els.get(id);
    };
    const sessionStorage = makeStorage(stored === undefined ? {} : { [key]: stored });
    const sandbox = {
      console,
      URLSearchParams,
      encodeURIComponent,
      sessionStorage,
      window: { location: { search }, history: { replaceState() {} } },
      document: {
        getElementById: el,
        createElement: () => el('__created__' + els.size),
        querySelector: () => el('__q'),
        querySelectorAll: () => [],
        addEventListener() {},
        body: el('__body'),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox, { filename: file });
    return els;
  };
  await check(`${file}: discovery -- the handout personalization script was found`, () => {
    assert.ok(scriptSrc, 'no inline script referencing the storage key');
  });
  await check(`${file}: POSITIVE CONTROL -- the contact stored by THIS funnel click (same code) personalizes the handout`, () => {
    const els = runHandout({ search: '?code=MYCODE', stored: JSON.stringify({ name: 'My Agent', company: 'My Agency', code: 'MYCODE' }) });
    assert.equal(els.get('cbName') && els.get('cbName').textContent, 'My Agent');
  });
  await check(`${file}: the URL ?code= wins over a stale stored code for the referral link`, () => {
    const els = runHandout({ search: '?code=NEWCODE', stored: JSON.stringify({ name: 'Old Agent', company: 'Old Agency', code: 'OLDCODE' }) });
    const link = els.get('refLinkBox') && els.get('refLinkBox').textContent;
    assert.ok(link && link.includes('NEWCODE') && !link.includes('OLDCODE'), String(link));
  });
  await knownGap(`${file}: a stored contact left by a DIFFERENT partner (stored code != URL code) is not shown on this handout`, () => {
    const els = runHandout({ search: '?code=NEWCODE', stored: JSON.stringify({ name: 'Old Agent', company: 'Old Agency', code: 'OLDCODE' }) });
    const name = els.get('cbName') && els.get('cbName').textContent;
    assert.ok(name !== 'Old Agent', `another partner's name was rendered on this handout: ${name}`);
  });
}

console.log(`\n${passes} passed, ${knownGaps} known gap(s), ${failures} failed.`);
if (failures > 0) process.exit(1);
console.log('✓ All gh-2060 static-surface staleness checks pass.');
process.exit(0);
