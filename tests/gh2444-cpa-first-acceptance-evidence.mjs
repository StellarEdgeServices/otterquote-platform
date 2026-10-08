/**
 * gh-2444 -- contractor-dashboard.html first agreement + CPA acceptance must record
 * the same evidence as re-acceptance: record_cpa_ip rpc + activity_log 'cpa_accepted' row,
 * both through ONE shared function, only after the row-checked update succeeds.
 * Part (a): a RETURNED supabase-js {error} (not only a throw) from either write is a failure.
 *
 * Runs the REAL recordCpaAcceptanceEvidence() source extracted from the page.
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

const shared = extractFn(html, 'recordCpaAcceptanceEvidence');
ok(!!shared, 'shared recordCpaAcceptanceEvidence() exists');
const first = extractFn(html, 'initAgreementModal');
const re = extractFn(html, 'initCpaReacceptModal');
ok(!!first && !!re, 'both acceptance handlers found');

// Both paths call the shared function; neither inlines its own rpc/insert any more.
ok((first.match(/recordCpaAcceptanceEvidence\(/g) || []).length === 1, 'first acceptance calls shared fn');
ok((re.match(/recordCpaAcceptanceEvidence\(/g) || []).length === 1, 're-acceptance calls shared fn');
ok(!/record_cpa_ip/.test(first + re), 'no inline record_cpa_ip left in handlers');
ok(!/event_type:\s*'cpa_accepted'/.test(first + re), 'no inline cpa_accepted insert left in handlers');

// Ordering: the call sits inside `if (!error)` after the row-checked update, before reload.
const iErr = first.indexOf('if (!error)');
const iCall = first.indexOf('recordCpaAcceptanceEvidence(');
const iReload = first.indexOf('location.reload()');
ok(iErr > -1 && iCall > iErr && iReload > iCall, 'first acceptance: evidence only after successful update, awaited before reload');
ok(/await recordCpaAcceptanceEvidence\(/.test(first), 'first acceptance awaits the evidence call');

// Behaviour of the real function. supabase-js RETURNS {error} (it does not throw),
// so failures are simulated as RETURNED errors; a throw is covered as a second mode.
// mode: 'ok' | 'ret' (returned {error}) | 'throw'
async function run(rpcMode, insertMode) {
  const calls = { rpc: [], ins: [] };
  const mk = (mode, log, args) => {
    log.push(args);
    if (mode === 'throw') throw new Error('thrown');
    return mode === 'ret' ? { data: null, error: { message: 'returned' } } : { data: null, error: null };
  };
  const ctx = {
    console: { warn() {}, error() {} },
    currentContractor: { id: 'c-1' }, currentUser: { id: 'u-1' },
    sb: {
      rpc: async (n, a) => mk(rpcMode, calls.rpc, [n, a]),
      from: (t) => ({ insert: async (r) => mk(insertMode, calls.ins, [t, r]) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext('async ' + shared + '; this.fn = recordCpaAcceptanceEvidence;', ctx);
  calls.result = await ctx.fn('2026-10-06T00:00:00.000Z', 'T');
  return calls;
}
let c = await run('ok', 'ok');
ok(c.rpc.length === 1 && c.rpc[0][0] === 'record_cpa_ip' && c.rpc[0][1].p_contractor_id === 'c-1', 'calls record_cpa_ip with contractor id');
ok(c.ins.length === 1 && c.ins[0][0] === 'activity_log' && c.ins[0][1].event_type === 'cpa_accepted'
  && c.ins[0][1].user_id === 'u-1' && c.ins[0][1].title === 'T', 'inserts activity_log cpa_accepted row');
ok(c.result === null, 'success returns null');
c = await run('ret', 'ok');
ok(c.result && c.result.message === 'returned', 'RETURNED record_cpa_ip {error} is reported as a failure');
ok(c.ins.length === 0, 'returned rpc error stops before the activity_log insert (no duplicate row on retry)');
c = await run('ok', 'ret');
ok(c.result && c.result.message === 'returned' && c.rpc.length === 1, 'RETURNED activity_log insert {error} is reported as a failure');
c = await run('throw', 'ok');
ok(c.result instanceof Error, 'thrown record_cpa_ip is also reported as a failure');
c = await run('ok', 'throw');
ok(c.result instanceof Error, 'thrown activity_log insert is also reported as a failure');

// Callers act on the returned error and re-enable the button; first acceptance disables it in flight.
ok(/const evidenceErr = await recordCpaAcceptanceEvidence\(/.test(first) && /if \(evidenceErr\)/.test(first), 'first acceptance checks the evidence result');
ok(/const evidenceErr = await recordCpaAcceptanceEvidence\(/.test(re) && /if \(evidenceErr\)/.test(re), 're-acceptance checks the evidence result');
ok(first.indexOf('button.disabled = true') > -1 && first.indexOf('button.disabled = true') < first.indexOf('.update('), 'first acceptance disables the button before the write');
ok((first.match(/button\.disabled = false/g) || []).length >= 3, 'first acceptance re-enables the button on every failure path');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
