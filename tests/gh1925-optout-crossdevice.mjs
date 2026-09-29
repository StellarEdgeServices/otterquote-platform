/**
 * gh-1925 residual -- a signed-in visitor's section 12 opt-out follows the PERSON (profiles.ad_sharing_opt_out), not just the browser.
 * Runs the REAL inline script of privacy.html in vm with a fake cookie jar, CONFIG and fetch.
 * Env PRIVACY_FILE overrides the file under test (used to run the negative control against origin/main's privacy.html).
 * Run: node tests/gh1925-optout-crossdevice.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.PRIVACY_FILE || path.join(ROOT, 'privacy.html');
const html = fs.readFileSync(file, 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const UID = '0b9d2f3e-1a2b-4c3d-8e9f-a1b2c3d4e5f6';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const goodToken = 'h.' + b64u({ sub: UID }) + '.s';

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('oq-ad-optout-btn'));
ok(scripts.length === 1, 'privacy.html has exactly one inline script wiring the section 12 button');

function run({ jar = '', cfg = { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON: 'anon-key' }, fetchImpl }) {
  const calls = []; const cookieWrites = []; let listener = null; let cookieJar = jar;
  const btn = { disabled: false, addEventListener(t, fn) { if (t === 'click') listener = fn; } };
  const document = {
    get cookie() { return cookieJar; },
    set cookie(v) { cookieWrites.push(v); },
    getElementById: (id) => (id === 'oq-ad-optout-btn' ? btn : null),
  };
  const fetchFn = fetchImpl || ((url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }); });
  const ctx = { window: { location: { hostname: 'otterquote.com' } }, document, navigator: {}, CONFIG: cfg, fetch: fetchFn, atob: (s) => Buffer.from(s, 'base64').toString('binary'), decodeURIComponent, encodeURIComponent, JSON, String, Date, RegExp };
  if (fetchImpl) ctx.fetch = (u, o) => { calls.push({ url: u, opts: o }); return fetchImpl(u, o); };
  vm.createContext(ctx);
  vm.runInContext(scripts[0] || '', ctx);
  return { btn, click: () => listener && listener(), calls, cookieWrites };
}

// 1. signed in: one PATCH to the person's own row, cookie still written
{
  const r = run({ jar: 'sb-otterquote-at=' + encodeURIComponent(goodToken) });
  r.click();
  ok(r.cookieWrites.length === 1 && /^oq_ad_optout=1;/.test(r.cookieWrites[0]), 'signed in: the oq_ad_optout cookie is still written');
  ok(r.calls.length === 1, 'signed in: exactly one profile write is sent (got ' + r.calls.length + ')');
  const c = r.calls[0];
  if (c) {
    ok(c.opts.method === 'PATCH' && c.url.startsWith('https://x.supabase.co/rest/v1/profiles?id=eq.' + UID), 'signed in: PATCH targets the caller\'s own profile row only (' + c.url + ')');
    ok(c.url.includes('or=(ad_sharing_opt_out.is.null,ad_sharing_opt_out.eq.false)'), 'signed in: an already-true flag is never rewritten (or-filter)');
    ok(c.opts.headers.Authorization === 'Bearer ' + goodToken && c.opts.headers.apikey === 'anon-key', 'signed in: uses the user\'s own token + publishable key');
    const b = JSON.parse(c.opts.body);
    ok(b.ad_sharing_opt_out === true && typeof b.ad_sharing_opt_out_at === 'string' && !('ad_sharing_opt_out_source' in b) && Object.keys(b).length === 2, 'signed in: body sets only the flag and its timestamp (source untouched, CHECK-safe)');
  } else { ok(false, 'signed in: a PATCH call exists to inspect'); }
  ok(r.btn.disabled === true, 'signed in: button disabled after click');
}
// 2. signed out: cookie only, no network
{
  const r = run({ jar: '' }); r.click();
  ok(r.cookieWrites.length === 1 && r.calls.length === 0, 'signed out: cookie written, zero profile writes');
}
// 3. malformed / hostile token: no write, no throw
for (const [name, tok] of [['not a jwt', 'abc'], ['sub not a uuid', 'h.' + b64u({ sub: "1' or 1=1" }) + '.s'], ['no sub', 'h.' + b64u({}) + '.s']]) {
  let threw = false; const r = run({ jar: 'sb-otterquote-at=' + encodeURIComponent(tok) });
  try { r.click(); } catch (e) { threw = true; }
  ok(!threw && r.calls.length === 0 && r.cookieWrites.length === 1, name + ': no profile write, no throw, cookie still written');
}
// 4. no CONFIG: no write
{ const r = run({ jar: 'sb-otterquote-at=' + encodeURIComponent(goodToken), cfg: null }); r.click(); ok(r.calls.length === 0 && r.cookieWrites.length === 1, 'no CONFIG: no profile write, cookie still written'); }
// 5. fetch rejects: never blocks the opt-out
{
  let threw = false;
  const r = run({ jar: 'sb-otterquote-at=' + encodeURIComponent(goodToken), fetchImpl: () => Promise.reject(new Error('net')) });
  try { r.click(); } catch (e) { threw = true; }
  ok(!threw && r.cookieWrites.length === 1 && r.btn.disabled === true, 'fetch rejects: no throw, cookie written, button disabled');
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
