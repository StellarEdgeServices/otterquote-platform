/**
 * gh-2444 / gh-2995 -- contractor-dashboard.html first agreement + CPA re-acceptance must record the acceptance
 * evidence through ONE server-side call: rpc('accept_cpa', { p_version }) (append-only record, contractors update
 * and activity_log row written atomically by the database). Supersedes the gh-2444 browser-side sequence
 * (contractors PATCH + record_cpa_ip + activity_log POST), which is asserted ABSENT below (negative controls).
 * A RETURNED supabase-js {error} (not only a throw) is a failure; a response without acceptance_id is a failure.
 *
 * Runs the REAL acceptCpaServerSide() source extracted from the page.
 * Run: node tests/gh2444-cpa-first-acceptance-evidence.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'contractor-dashboard.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}

const shared = extractFn(html, 'acceptCpaServerSide');
ok(!!shared, 'shared acceptCpaServerSide() exists');
if (!shared) { console.log(`\n${pass} passed, ${fail} failed (acceptCpaServerSide missing: remaining checks need it)`); process.exit(1); }
const first = extractFn(html, 'initAgreementModal');
const re = extractFn(html, 'initCpaReacceptModal');
ok(!!first && !!re, 'both acceptance handlers found');

// Both paths call the shared function; neither writes the evidence from the browser any more.
ok((first.match(/acceptCpaServerSide\(/g) || []).length === 1, 'first acceptance calls shared fn');
ok((re.match(/acceptCpaServerSide\(/g) || []).length === 1, 're-acceptance calls shared fn');
ok(/await acceptCpaServerSide\(CURRENT_CPA_VERSION\)/.test(first) && /await acceptCpaServerSide\(CURRENT_CPA_VERSION\)/.test(re), 'both paths await the call with the version id constant');
// NEGATIVE CONTROLS: the old browser-side evidence writes are gone from the whole page.
ok(!/record_cpa_ip/.test(html), 'NEG: no record_cpa_ip call left anywhere in the page');
ok(!/event_type:\s*'cpa_accepted'/.test(html), 'NEG: no browser-side cpa_accepted activity_log insert left');
ok(!/recordCpaAcceptanceEvidence/.test(html), 'NEG: the old browser-side evidence function is gone');
ok(!/agreement_version:\s*today/.test(html) && !/split\('T'\)\[0\]/.test(first), 'NEG: agreement_version is no longer written as today\'s date');
ok(!/\.update\(/.test(first + re), 'NEG: neither handler PATCHes contractors from the browser (client clock timestamps gone)');
ok(!/new Date\(\)\.toISOString\(\)/.test(first + re), 'NEG: neither handler stamps a browser-clock time');

// gh-2995 (#3037) F2/F3: pre-approval step 3 goes through accept_cpa and no longer writes acceptance columns from the browser.
{
  const pre = fs.readFileSync(path.join(root, 'contractor-pre-approval.html'), 'utf8');
  ok(/sb\.rpc\('accept_cpa', \{ p_version: 'v1-2026-04' \}\)/.test(pre), 'pre-approval step 3 calls rpc accept_cpa');
  ok(!/\bcpa_accepted_at:/.test(pre) && !/\bagreement_accepted_at:/.test(pre) && !/\bagreement_version:/.test(pre) && !/\bcpa_version:/.test(pre), 'NEG: pre-approval writes no acceptance column from the browser');
}
ok(!/currentContractor\.agreement_version\s*=/.test(html), 'NEG: dashboard never sets agreement_version (D-366)');

// Ordering: in-memory state and reload happen only after a successful call.
const iErr = first.indexOf('if (!error)');
const iCall = first.indexOf('acceptCpaServerSide(');
const iReload = first.indexOf('location.reload()');
ok(iCall > -1 && iErr > iCall && iReload > iErr, 'first acceptance: reload only after the awaited call succeeded');
ok(first.indexOf('button.disabled = true') > -1 && first.indexOf('button.disabled = true') < iCall, 'first acceptance disables the button before the call');
ok((first.match(/button\.disabled = false/g) || []).length >= 2, 'first acceptance re-enables the button on a failure path');
ok(/if \(accepted\.error\)/.test(re) && (re.match(/button\.disabled = false/g) || []).length >= 2, 're-acceptance checks the result and re-enables the button');

// Existing error copy only (no new wording).
ok(first.includes("alert('Error accepting agreement. Please try again.');") && re.includes("alert('Error saving agreement acceptance. Please try again.');"), 'existing alert copy retained');

// Behaviour of the real function. mode: 'ok' | 'ret' (returned {error}) | 'throw' | 'norec' (no acceptance_id)
async function run(mode) {
  const calls = [];
  const ctx = {
    console: { warn() {}, error() {} },
    sb: {
      rpc: async (n, a) => {
        calls.push([n, a]);
        if (mode === 'throw') throw new Error('thrown');
        if (mode === 'ret') return { data: null, error: { message: 'returned' } };
        if (mode === 'norec') return { data: {}, error: null };
        return { data: { acceptance_id: 'acc-1', accepted_at: '2026-10-23T00:00:00Z' }, error: null };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext('async ' + shared + '; this.fn = acceptCpaServerSide;', ctx);
  const result = await ctx.fn('v1-2026-04');
  return { calls, result };
}
let c = await run('ok');
ok(c.calls.length === 1 && c.calls[0][0] === 'accept_cpa' && c.calls[0][1].p_version === 'v1-2026-04' && Object.keys(c.calls[0][1]).length === 1, 'calls accept_cpa with only p_version (the server derives contractor, time, IP, UA)');
ok(c.result.error === null && c.result.data.acceptance_id === 'acc-1', 'success returns the server record');
c = await run('ret');
ok(c.result.error && c.result.error.message === 'returned' && c.result.data === null, 'NEG: a RETURNED {error} is a failure');
c = await run('throw');
ok(c.result.error instanceof Error, 'NEG: a thrown rpc is a failure');
c = await run('norec');
ok(c.result.error && /accept_cpa_no_record/.test(c.result.error.message), 'NEG: a response with no acceptance_id is a failure');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
