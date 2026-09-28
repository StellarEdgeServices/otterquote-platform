/**
 * gh-1980 PR 3/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE") -- static
 * stack flowType flip guard.
 *
 *   (1) Repo-wide: every browser-side `createClient(` call in a tracked HTML
 *       file / js/config.js / js/supabase-client.js that passes the canonical
 *       storageKey also passes `flowType: 'pkce'`. The only createClient()
 *       calls allowed to lack it are the 4 bare funnel-page calls (hi-4, hi-5,
 *       ins-3, ins-5) -- NOT converged, awaiting Ben's ruling (Marty,
 *       #1980 comment 5869732606). A new bare call anywhere else fails.
 *   (2) js/supabase-client.js, executed against a fake supabase-js, constructs
 *       the shared client with auth.flowType === 'pkce'.
 *   (3) auth-callback.html falls back to the legacy #access_token fragment
 *       (setSession) when supabase-js's pkce client yields no session.
 *
 * Negative control: against origin/main (no flowType anywhere) (1) and (2)
 * FAIL. Run: node tests/gh1980-pr3-pkce-flow.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// Not converged, awaiting Ben (funnel lane): bare `createClient(URL, ANON)`.
const BARE_FUNNEL_ALLOWLIST = new Set(['hi-4.html', 'hi-5.html', 'ins-3.html', 'ins-5.html']);

function callArgs(src, startIdx) { // paren-balanced text of the call starting at '('
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(startIdx, i + 1);
  }
  return src.slice(startIdx);
}

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').filter(f => /\.html$/.test(f) || f === 'js/config.js' || f === 'js/supabase-client.js');

let sites = 0;
const bad = [];
for (const rel of tracked) {
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const re = /(?<![A-Za-z0-9_.])(?:window\.)?(?:supabase\.)?createClient\(/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\/\/|\*|<!--)/.test(src.slice(lineStart, m.index + 1))) continue; // comment mention
    const args = callArgs(src, m.index + m[0].length - 1);
    if (!args.includes(',')) continue; // prose like "createClient()" -- a real construction always passes (url, key)
    sites++;
    if (/storageKey/.test(args)) {
      if (!/flowType:\s*'pkce'/.test(args)) bad.push(rel + ' (storageKey without flowType:pkce)');
    } else if (!BARE_FUNNEL_ALLOWLIST.has(rel)) {
      bad.push(rel + ' (bare createClient, not on the Ben-awaiting allowlist)');
    }
  }
}
ok(sites >= 26, `(1) found the createClient construction sites (${sites})`);
ok(bad.length === 0, '(1) every converged createClient passes flowType:pkce; no unlisted bare calls' + (bad.length ? ' -- ' + bad.join('; ') : ''));

// (2) run js/supabase-client.js against a fake supabase-js
{
  const calls = [];
  const win = { supabase: { createClient: (u, k, o) => { calls.push(o); return { fake: true }; } },
                OtterQuoteCookieStorage: {}, OTTERQUOTE_AUTH_STORAGE_KEY: 'sb-otterquote-auth' };
  const ctx = vm.createContext({ window: win, CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON: 'anon' } });
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'js/supabase-client.js'), 'utf8'), ctx);
  ok(calls.length === 1, '(2) js/supabase-client.js constructs exactly one client');
  ok(calls[0] && calls[0].auth && calls[0].auth.flowType === 'pkce', "(2) that client has auth.flowType === 'pkce'");
  ok(calls[0] && calls[0].auth && calls[0].auth.storageKey === 'sb-otterquote-auth', '(2) ...and the canonical storageKey');
}

// (3) callback fallback present
{
  const cb = fs.readFileSync(path.join(repoRoot, 'auth-callback.html'), 'utf8');
  ok(/rescueImplicitFragment/.test(cb) && /sb\.auth\.setSession\(/.test(cb), '(3) auth-callback.html rescues a legacy #access_token fragment via setSession');
  ok(/INITIAL_SESSION[\s\S]{0,900}rescueImplicitFragment\(\)\.then/.test(cb), '(3) ...on a null INITIAL_SESSION, instead of idling to the 30 s timeout');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);