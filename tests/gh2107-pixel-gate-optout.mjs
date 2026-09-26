/**
 * gh-2107 / D-330 -- the STATIC Meta Pixel gate (js/meta-pixel-gate.js, loaded by 63 pages) honours the advertising-sharing
 * opt-out. Ben's ruling on #2078 (5805593465, item a): "For GPC=1 or ad_sharing_opt_out = true, the Meta pixel does not load."
 *
 * Runs the REAL js/meta-pixel-gate.js in a vm context with a fake window, document, navigator and cookie jar, and asserts
 * whether the fbevents.js <script> is ever inserted.
 *
 * Run: node tests/gh2107-pixel-gate-optout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'js', 'meta-pixel-gate.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function run({ host = 'otterquote.com', gpc, cookie = '', hash = '', search = '', fetchImpl, config } = {}) {
  const appended = [];
  const cookieWrites = [];
  let jar = cookie;
  const doc = {
    get cookie() { return jar; },
    set cookie(v) { cookieWrites.push(v); const [kv] = v.split(';'); const [k] = kv.split('='); const rest = jar.split('; ').filter((c) => c && !c.startsWith(k + '=')); rest.push(kv); jar = rest.join('; '); },
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
  };
  const win = {
    location: { hostname: host, hash, search },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; }, // run the idle load immediately
    cancelIdleCallback() {},
  };
  const nav = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  const ctx = { window: win, document: doc, navigator: nav, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, atob, encodeURIComponent, Promise, JSON };
  if (fetchImpl) ctx.fetch = fetchImpl;
  if (config) ctx.CONFIG = config;
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const count = () => appended.filter((e) => e.tag === 'script' && String(e.src).indexOf('connect.facebook.net/en_US/fbevents.js') !== -1).length;
  const r = { get loaded() { return count() === 1; }, get fbevents() { return count(); }, cookieWrites, fbq: win.fbq };
  return r;
}
const settle = () => new Promise((res) => setTimeout(res, 40));

// CONTROL: the gate still loads the pixel for an ordinary visitor on a production host
{
  const r = run();
  ok(r.loaded, 'CONTROL: an ordinary visitor on otterquote.com loads fbevents.js exactly once');
  ok(typeof r.fbq === 'function', 'CONTROL: fbq is defined');
}
// GPC on
{
  const r = run({ gpc: true });
  ok(!r.loaded, 'GPC on: fbevents.js is NOT loaded');
  ok(r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1')), 'GPC on: the oq_ad_optout cookie is left behind');
  ok(r.cookieWrites.some((w) => /Domain=\.otterquote\.com/.test(w) && /Max-Age=31536000/.test(w)), 'the cookie is scoped to .otterquote.com for one year (the same shape as oq_internal)');
  ok(typeof r.fbq === 'function', 'GPC on: fbq is still defined, so every page\'s existing fbq(...) calls stay harmless queued pushes');
  let threw = false; try { r.fbq('track', 'Lead'); } catch (e) { threw = true; }
  ok(!threw, 'GPC on: an existing fbq(...) call site does not throw');
}
// the cookie alone
{
  const r = run({ cookie: 'oq_ad_optout=1' });
  ok(!r.loaded, 'the oq_ad_optout cookie alone (no GPC) keeps fbevents.js off');
  ok(r.cookieWrites.length === 0, 'no cookie is rewritten when it is already there');
}
// signals that are NOT an opt-out
for (const [label, opts] of [['GPC false', { gpc: false }], ['GPC undefined', {}], ['GPC "true" (a string)', { gpc: 'true' }], ['GPC 1', { gpc: 1 }], ['cookie 0', { cookie: 'oq_ad_optout=0' }], ['cookie yes', { cookie: 'oq_ad_optout=yes' }]]) {
  const r = run(opts);
  ok(r.loaded, label + ': not an opt-out, the pixel loads');
}
// the existing reasons not to load still hold, independently
ok(!run({ host: 'staging--jade-alpaca-b82b5e.netlify.app' }).loaded, 'a non-production host still never loads the pixel');
ok(!run({ hash: '#access_token=abc' }).loaded, 'a URL carrying an auth token still never loads the pixel');
ok(!run({ search: '?oq_internal=1' }).loaded, 'internal traffic still never loads the pixel');
// a broken environment must not break the page or wrongly opt anyone out
{
  const win = { location: { hostname: 'otterquote.com', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} };
  const appended = [];
  const nav = {}; Object.defineProperty(nav, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
  const ctx = { window: win, document: { cookie: '', createElement: (t) => ({ tag: t }), head: { appendChild: (e) => appended.push(e) } }, navigator: nav, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout };
  win.window = win; vm.createContext(ctx);
  let threw = false; try { vm.runInContext(src, ctx); } catch (e) { threw = true; }
  ok(!threw, 'a navigator whose globalPrivacyControl getter throws does not break the page');
}


// ---------------------------------------------------------------------------------------------------------------------
// REVIEW: FAIL 5806828503 F1 on #2134: "when the stored flag is true and the browser has neither GPC nor the cookie, the pixel still
// loads on 63 static pages." The gate now reads the signed-in visitor's stored flag BEFORE loading, whenever the SSO session cookie
// (sb-otterquote-at, js/cookie-storage.js) is present. No session cookie: nothing is knowable, load as before.
// ---------------------------------------------------------------------------------------------------------------------
const UID = '11111111-2222-4333-8444-555555555555';
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// Built at run time (a literal base64 JWT header trips the secret scanners even though this is a fake, unsigned test token).
const TOKEN = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: UID, role: 'authenticated', exp: 4102444800 }) + '.' + 'fake-signature';
const SESSION_COOKIE = 'sb-otterquote-at=' + encodeURIComponent(TOKEN);
const CONFIG = { SUPABASE_URL: 'https://yeszghaspzwwstvsrioa.supabase.co', SUPABASE_ANON: 'sb_publishable_test' };
function profileFetch(rows, opts = {}) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url: String(url), init });
    if (opts.throws) return Promise.reject(new Error('down'));
    return Promise.resolve({ ok: opts.status === undefined ? true : opts.status < 400, status: opts.status || 200, json: () => (opts.badJson ? Promise.reject(new Error('bad')) : Promise.resolve(rows)) });
  };
  fn.calls = calls;
  return fn;
}

{
  // the reported case: signed in, stored flag TRUE, NO GPC, NO cookie -> no pixel
  const f = profileFetch([{ ad_sharing_opt_out: true }]);
  const r = run({ cookie: SESSION_COOKIE, fetchImpl: f, config: CONFIG });
  await settle();
  ok(!r.loaded, 'F1: signed in with the stored flag TRUE, no GPC and no oq_ad_optout cookie -> fbevents.js is NOT loaded');
  ok(r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1')), 'F1: the stored opt-out leaves the oq_ad_optout cookie for every later page (both stacks)');
  ok(f.calls.length === 1, 'F1: exactly one profile read');
  const c = f.calls[0];
  ok(c.url === CONFIG.SUPABASE_URL + '/rest/v1/profiles?select=ad_sharing_opt_out&id=eq.' + UID, 'F1: it reads ONLY the signed-in user\'s own row, by the id in the session token (' + c.url + ')');
  ok(c.init.method === 'GET' && c.init.headers.apikey === CONFIG.SUPABASE_ANON && c.init.headers.Authorization === 'Bearer ' + TOKEN, 'F1: a GET with the public key and the user\'s own token as the bearer (RLS applies)');
}
for (const [label, rows] of [['NULL', [{ ad_sharing_opt_out: null }]], ['false', [{ ad_sharing_opt_out: false }]], ['no profile row', []]]) {
  const f = profileFetch(rows);
  const r = run({ cookie: SESSION_COOKIE, fetchImpl: f, config: CONFIG });
  ok(!r.loaded, 'F1: signed in, flag ' + label + ': the pixel does NOT load synchronously (it waits for the read)');
  await settle();
  ok(r.loaded, 'F1: signed in, flag ' + label + ': the pixel loads after the read (not an opt-out)');
  ok(r.cookieWrites.length === 0, 'F1: signed in, flag ' + label + ': no opt-out cookie is written');
}
{
  // a value that is not exactly true is not an opt-out
  for (const v of ['true', 1, '1']) {
    const r = run({ cookie: SESSION_COOKIE, fetchImpl: profileFetch([{ ad_sharing_opt_out: v }]), config: CONFIG });
    await settle();
    ok(r.loaded, 'F1: a stored value of ' + JSON.stringify(v) + ' (not the boolean true) is not an opt-out');
  }
}
// a session whose flag could NOT be read: unknown is not shared
for (const [label, opts] of [['a 401', { status: 401 }], ['a 500', { status: 500 }], ['a thrown fetch', { throws: true }], ['an unparseable body', { badJson: true }], ['a non-array body', {}]]) {
  const rows = label === 'a non-array body' ? { message: 'x' } : [];
  const r = run({ cookie: SESSION_COOKIE, fetchImpl: profileFetch(rows, opts), config: CONFIG });
  await settle();
  ok(!r.loaded, 'F1: a session whose profile read is ' + label + ' -> the pixel does NOT load (an unknown opt-out is not shared)');
}
{
  // js/config.js is loaded later on the page, so the gate WAITS (up to 5 s) for CONFIG; if it never appears the flag cannot be read
  // and the pixel must stay off (fail closed).
  const noCfgFetch = profileFetch([{ ad_sharing_opt_out: false }]);
  const noCfg = run({ cookie: SESSION_COOKIE, fetchImpl: noCfgFetch });
  await settle();
  ok(!noCfg.loaded && noCfgFetch.calls.length === 0, 'F1: a session but CONFIG not defined yet -> the gate waits: no read and no pixel yet');
  await new Promise((res) => setTimeout(res, 5400));
  ok(!noCfg.loaded && noCfgFetch.calls.length === 0, 'F1: a session but CONFIG NEVER appears -> after the 5 s wait the pixel is still NOT loaded (unknown is not shared)');
  const badTok = run({ cookie: 'sb-otterquote-at=' + encodeURIComponent('not.a.jwt'), fetchImpl: profileFetch([{ ad_sharing_opt_out: false }]), config: CONFIG });
  await settle();
  ok(!badTok.loaded, 'F1: a session cookie whose token has no readable user id -> not loaded');
  const noSub = run({ cookie: 'sb-otterquote-at=' + encodeURIComponent('h.' + b64url({ role: 'x' }) + '.s'), fetchImpl: profileFetch([{ ad_sharing_opt_out: false }]), config: CONFIG });
  await settle();
  ok(!noSub.loaded, 'F1: a token with no sub claim -> not loaded');
  const evilSub = run({ cookie: 'sb-otterquote-at=' + encodeURIComponent('h.' + b64url({ sub: UID + '&or=(1=1)' }) + '.s'), fetchImpl: profileFetch([{ ad_sharing_opt_out: false }]), config: CONFIG });
  await settle();
  ok(!evilSub.loaded, 'F1: a sub that is not a plain UUID (an injection attempt in the URL) is refused, not interpolated');
}
{
  // NO session cookie: nothing is knowable, the pixel loads exactly as before, and NO profile read is made
  const f = profileFetch([{ ad_sharing_opt_out: true }]);
  const r = run({ fetchImpl: f, config: CONFIG });
  ok(r.loaded, 'F1: no session cookie -> the pixel loads immediately, as before');
  ok(f.calls.length === 0, 'F1: no session cookie -> no profile read at all');
}
{
  // the synchronous signals still win and make no read
  const f = profileFetch([{ ad_sharing_opt_out: false }]);
  const r = run({ gpc: true, cookie: SESSION_COOKIE, fetchImpl: f, config: CONFIG });
  await settle();
  ok(!r.loaded && f.calls.length === 0, 'F1: GPC on -> no pixel and no profile read (the synchronous signal wins)');
  const r2 = run({ cookie: SESSION_COOKIE + '; oq_ad_optout=1', fetchImpl: f, config: CONFIG });
  await settle();
  ok(!r2.loaded && f.calls.length === 0, 'F1: the oq_ad_optout cookie -> no pixel and no profile read');
}
{
  // the existing reasons not to load still hold with a session present
  const f = profileFetch([{ ad_sharing_opt_out: false }]);
  const a = run({ host: 'staging--jade-alpaca-b82b5e.netlify.app', cookie: SESSION_COOKIE, fetchImpl: f, config: CONFIG });
  const b = run({ hash: '#access_token=abc', cookie: SESSION_COOKIE, fetchImpl: f, config: CONFIG });
  await settle();
  ok(!a.loaded && !b.loaded && f.calls.length === 0, 'F1: a non-production host or a token in the URL still never loads the pixel, and makes no read');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
