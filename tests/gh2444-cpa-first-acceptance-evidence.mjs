/**
 * gh-2444 -- contractor-dashboard.html first agreement + CPA acceptance must record
 * the same evidence as re-acceptance: record_cpa_ip rpc + activity_log 'cpa_accepted' row,
 * both through ONE shared function, only after the row-checked update succeeds.
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

// Behaviour of the real function.
async function run(rpcThrows, insertThrows) {
  const calls = { rpc: [], ins: [] };
  const ctx = {
    console: { warn() {} },
    currentContractor: { id: 'c-1' }, currentUser: { id: 'u-1' },
    sb: {
      rpc: async (n, a) => { calls.rpc.push([n, a]); if (rpcThrows) throw new Error('x'); },
      from: (t) => ({ insert: async (r) => { calls.ins.push([t, r]); if (insertThrows) throw new Error('y'); } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext('async ' + shared + '; this.fn = recordCpaAcceptanceEvidence;', ctx);
  await ctx.fn('2026-10-06T00:00:00.000Z', 'T');
  return calls;
}
let c = await run(false, false);
ok(c.rpc.length === 1 && c.rpc[0][0] === 'record_cpa_ip' && c.rpc[0][1].p_contractor_id === 'c-1', 'calls record_cpa_ip with contractor id');
ok(c.ins.length === 1 && c.ins[0][0] === 'activity_log' && c.ins[0][1].event_type === 'cpa_accepted'
  && c.ins[0][1].user_id === 'u-1' && c.ins[0][1].title === 'T', 'inserts activity_log cpa_accepted row');
c = await run(true, false);
ok(c.ins.length === 1, 'rpc failure is non-fatal; activity_log still written');
c = await run(false, true);
ok(c.rpc.length === 1, 'insert failure is non-fatal');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
