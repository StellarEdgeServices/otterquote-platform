/**
 * gh-1980 PR 3/3, RE-SCOPED per Ben's ruling (#1980 comment 5889011351, Dustin
 * verbatim: "PKCE for Google only (Recommended)"): OAuth (Google) is PKCE;
 * emailed magic / recovery / confirmation links stay IMPLICIT and must be
 * rescued on every page that can be a redirectTo / emailRedirectTo landing page.
 *
 *   (a) No default / shared / inline browser client hard-codes flowType 'pkce'.
 *       The only 'pkce' literals allowed are the OAuth pieces (js/cookie-storage.js
 *       helper, js/auth.js Google initiation). js/config.js and
 *       js/supabase-client.js pick the flow per page load through
 *       OtterQuoteOAuthPkce.flowTypeForPageLoad(): 'pkce' ONLY for a
 *       `?code=` return that has a stored code-verifier (i.e. it is our own Google
 *       return), 'implicit' for everything else (fragment links, plain loads).
 *   (b) Google initiation (Auth.signInWithGoogle) uses a dedicated pkce client
 *       built on an isolated, verifier-only storage adapter under the canonical
 *       storageKey, never the shared implicit client; and ?code= is exchanged on
 *       return (flowTypeForPageLoad => 'pkce' => supabase-js exchanges natively).
 *   (c) Every redirect landing page (enumerated from auth-uniform's allow-list +
 *       the emailRedirectTo / redirectTo call sites) loads js/auth.js, which
 *       carries the shared implicit-fragment rescue, and has no inline script
 *       that navigates away BEFORE js/auth.js (except documented exceptions).
 *   (d) Email-initiated flows (auth-uniform EF, signUp, recover, OTP) are not
 *       pkce-bound: no code_challenge anywhere in the EF or the email callers.
 *   (e) auth-callback.html reuses the shared rescue (no second copy).
 *
 * Run: node tests/gh1980-pr3-pkce-flow.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// Code only: drop block / HTML / full-line comments so prose mentioning the old flip cannot trip a check.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

function fakeBrowser(href, store) {
  const u = new URL(href);
  const ls = new Map(Object.entries(store || {}));
  const calls = [];
  const win = {
    location: { href: u.href, search: u.search, hash: u.hash, hostname: u.hostname, protocol: u.protocol, pathname: u.pathname, origin: u.origin },
    localStorage: { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    supabase: { createClient: (url, key, o) => { calls.push(o); return { auth: { signInWithOAuth() {} } }; } },
    document: { cookie: '', referrer: '' },
    navigator: {},
    addEventListener() {},
  };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: win.document, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, navigator: win.navigator, console, setTimeout, clearTimeout, CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON: 'anon' }, URL, URLSearchParams, Date, JSON, Math, encodeURIComponent, decodeURIComponent });
  return { win, ctx, calls, ls };
}

// ---------------------------------------------------------------- (a)
{
  const pkceLiteral = /flowType\s*:\s*['"]pkce['"]/;
  const files = tracked.filter(f => (/\.html$/.test(f) || /^js\/.*\.js$/.test(f)));
  const offenders = files.filter(f => pkceLiteral.test(code(f)) && !['js/auth.js', 'js/cookie-storage.js'].includes(f));
  ok(offenders.length === 0, "(a) no page / shared client hard-codes flowType 'pkce' outside the OAuth pieces" + (offenders.length ? ' -- ' + offenders.slice(0, 6).join(', ') + (offenders.length > 6 ? ` (+${offenders.length - 6})` : '') : ''));

  const tsFiles = tracked.filter(f => /^react-app\/app\/.*\.(ts|tsx)$/.test(f) && !/__tests__|\.test\./.test(f));
  const tsOff = tsFiles.filter(f => pkceLiteral.test(code(f)) && f !== 'react-app/app/lib/supabase-oauth.ts' && f !== 'react-app/app/lib/oauth-pkce.ts');
  ok(tsOff.length === 0, "(a) react-app: no default client hard-codes flowType 'pkce' outside lib/oauth-pkce.ts / lib/supabase-oauth.ts" + (tsOff.length ? ' -- ' + tsOff.join(', ') : ''));

  const cfg = read('js/config.js'), shared = read('js/supabase-client.js');
  ok(/flowTypeForPageLoad/.test(cfg) && /flowTypeForPageLoad/.test(shared), '(a) js/config.js and js/supabase-client.js choose the flow per page load via flowTypeForPageLoad()');

  function flowFor(href, store) {
    const { ctx, calls } = fakeBrowser(href, store);
    try {
      vm.runInContext(read('js/cookie-storage.js'), ctx);
      vm.runInContext(read('js/supabase-client.js'), ctx);
    } catch (e) { return 'ERR:' + e.message; }
    return calls.length ? (calls[0].auth.flowType || 'implicit') : 'no-client';
  }
  const V = { 'sb-otterquote-auth-code-verifier': 'verifier123' };
  ok(flowFor('https://otterquote.com/dashboard.html') === 'implicit', '(a) plain page load -> implicit client');
  ok(flowFor('https://otterquote.com/dashboard.html#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer', V) === 'implicit', '(a) emailed-link fragment landing -> implicit client (even with a stale verifier stored)');
  ok(flowFor('https://otterquote.com/auth-callback.html?intent=homeowner&code=abc', V) === 'pkce', '(a) ?code= return WITH a stored code-verifier (our Google return) -> pkce client');
  ok(flowFor('https://otterquote.com/auth-callback.html?code=abc') === 'implicit', '(a) ?code= with NO stored verifier (referral-style ?code=, cross-device) -> implicit client');
  ok(flowFor('https://otterquote.com/x.html?code=abc&sb_flow_id=flow1', { 'sb-otterquote-auth-flow-flow1-code-verifier': 'v' }) === 'pkce', '(a) ?code= + sb_flow_id slot verifier -> pkce client');
}

// ---------------------------------------------------------------- (b)
{
  const auth = read('js/auth.js');
  const m = auth.match(/async signInWithGoogle\([\s\S]*?\n  \},/);
  const body = m ? m[0] : '';
  ok(body && /OtterQuoteOAuthPkce/.test(body) && !/\bsb\.auth\.signInWithOAuth/.test(body), '(b) Auth.signInWithGoogle initiates through the dedicated pkce client, not the shared sb');
  const cs = read('js/cookie-storage.js');
  ok(/createOAuthClient/.test(cs), '(b) js/cookie-storage.js defines the dedicated pkce OAuth client factory');

  const { win, ctx, calls, ls } = fakeBrowser('https://otterquote.com/login.html');
  try {
    vm.runInContext(cs, ctx);
    const o = win.OtterQuoteOAuthPkce;
    if (o && o.createOAuthClient) o.createOAuthClient('https://x.supabase.co', 'anon');
  } catch (e) { console.log('   (factory threw: ' + e.message + ')'); }
  const a = calls[0] && calls[0].auth;
  ok(!!a && a.flowType === 'pkce', "(b) OAuth client is flowType 'pkce'");
  ok(!!a && a.storageKey === 'sb-otterquote-auth', '(b) ...under the canonical storageKey, so the verifier lands where the callback reads it');
  ok(!!a && a.detectSessionInUrl === false && a.autoRefreshToken === false, '(b) ...with detectSessionInUrl / autoRefreshToken off (it only initiates)');
  const st = a && a.storage;
  let isolated = false;
  if (st && win.OtterQuoteCookieStorage) {
    ls.set('sb-otterquote-auth', 'SESSION');
    st.setItem('sb-otterquote-auth', 'CLOBBER'); st.removeItem('sb-otterquote-auth');
    st.setItem('sb-otterquote-auth-code-verifier', 'ver');
    isolated = st.getItem('sb-otterquote-auth') === null
      && ls.get('sb-otterquote-auth') === 'SESSION'
      && st.getItem('sb-otterquote-auth-code-verifier') === 'ver'
      && ls.get('sb-otterquote-auth-code-verifier') === 'ver';
  }
  ok(isolated, '(b) ...on a verifier-only storage adapter: never reads/writes/clears the shared session, but persists the -code-verifier to origin localStorage');
}

// ---------------------------------------------------------------- (c)
{
  const ef = read('supabase/functions/auth-uniform/index.ts');
  const staticSet = ef.match(/REDIRECT_STATIC_PATHS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const efPaths = [...staticSet.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  // Extra landing page from a non-EF call site: Auth.signInWithGoogle('/partner-insurance.html?g=1').
  const paths = [...new Set([...efPaths, '/partner-insurance.html'])];
  const files = paths.map(p => p === '/' ? 'index.html' : p.replace(/^\//, ''))
    .filter(f => /\.html$/.test(f)).filter(f => tracked.includes(f));
  ok(files.length >= 12, `(c) enumerated ${files.length} static landing pages: ${files.join(', ')}`);
  const need = ['contractor-pre-approval.html', 'partner-dashboard.html', 'dashboard.html', 'auth-callback.html', 'login.html', 'partner-login.html', 'index.html'];
  ok(need.every(f => files.includes(f)), '(c) the enumeration includes contractor-pre-approval, partner-dashboard, dashboard, auth-callback, login, partner-login, index');

  const auth = read('js/auth.js');
  ok(/function rescueImplicitFragment\b/.test(auth) && /setSession\(/.test(auth) && /replaceState/.test(auth), '(c) js/auth.js defines the shared rescueImplicitFragment (setSession + history scrub)');
  ok(/rescueImplicitFragment\(\)/.test(auth.slice(auth.indexOf('function rescueImplicitFragment') + 40)), '(c) ...and runs it at load on every page that loads js/auth.js');

  const EXCEPT = { 'login.html': /HOMEOWNER_LAUNCH_ENABLED/, 'partner-insurance.html': /HOMEOWNER_LAUNCH_ENABLED/, 'index.html': /hash/ };
  const bad = [];
  for (const f of files) {
    const src = read(f);
    const i = src.search(/<script[^>]+src=["'][^"']*js\/auth\.js/);
    if (i < 0) { bad.push(f + ' (does not load js/auth.js)'); continue; }
    const before = src.slice(0, i);
    const inl = [...before.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const s of inl) {
      if (/(location\.(replace|assign)\s*\(|location\.href\s*=[^=])/.test(s) && !(EXCEPT[f] && EXCEPT[f].test(s))) bad.push(f + ' (inline navigation before js/auth.js)');
    }
  }
  ok(bad.length === 0, '(c) every landing page loads js/auth.js and no inline script navigates before it (documented exceptions only)' + (bad.length ? ' -- ' + bad.join('; ') : ''));
}

// ---------------------------------------------------------------- (d)
{
  const ef = read('supabase/functions/auth-uniform/index.ts');
  ok(!/code_challenge|flowType/.test(ef), '(d) auth-uniform EF (magic link + recovery) carries no code_challenge / flowType: emails stay implicit');
  const emailCallers = ['js/auth.js', 'react-app/app/lib/auth-uniform.ts', 'react-app/app/get-started/page.tsx', 'react-app/app/login/page.tsx', 'react-app/app/contractor/login/page.tsx', 'contractor-join.html', 'ref-re.html', 'ref-inspector.html'];
  const withChallenge = emailCallers.filter(f => /code_challenge/.test(read(f)));
  ok(withChallenge.length === 0, '(d) no email caller passes a code_challenge' + (withChallenge.length ? ' -- ' + withChallenge.join(', ') : ''));
  const auth = read('js/auth.js');
  const su = auth.match(/async signUpWithPassword\([\s\S]*?\n  \},/)[0];
  ok(/\bsb\.auth\.signUp\(/.test(su) && !/OtterQuoteOAuthPkce/.test(su), '(d) signUp confirmation links go through the shared implicit client');
  const sm = auth.match(/async sendMagicLink\([\s\S]*?\n  \},/)[0];
  ok(/_callAuthUniform\('otp'/.test(sm) && !/OtterQuoteOAuthPkce/.test(sm), '(d) sendMagicLink goes through auth-uniform, never the pkce client');
}

// ---------------------------------------------------------------- (e)
{
  const cb = read('auth-callback.html');
  ok(!/function rescueImplicitFragment/.test(cb), '(e) auth-callback.html carries no private copy of the rescue');
  ok(/Auth\.rescueImplicitFragment\(/.test(cb), '(e) auth-callback.html calls the shared Auth.rescueImplicitFragment on a null INITIAL_SESSION');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
