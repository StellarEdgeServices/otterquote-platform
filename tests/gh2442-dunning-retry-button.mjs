/**
 * gh-2442 -- contractor-dashboard.html "Retry Payment Now" asks the server (request_dunning_retry) and shows the
 * status it returns; it makes no direct write to payment_failures.
 * Runs the REAL retryDunningPayment() source extracted from the page, in a vm behind a small DOM/Supabase shim.
 * Run: node tests/gh2442-dunning-retry-button.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'contractor-dashboard.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

function extractBlock(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}
const fnSrc = extractBlock(html, 'async function retryDunningPayment(');
const msgSrc = extractBlock(html, 'const DUNNING_RETRY_MESSAGES');
ok(!!fnSrc, 'retryDunningPayment() exists on the page');
ok(!!msgSrc, 'DUNNING_RETRY_MESSAGES exists on the page');
ok(!!fnSrc && !/\.from\(\s*['"]payment_failures['"]\s*\)/.test(fnSrc), 'retryDunningPayment() makes no direct payment_failures access');
ok(!!fnSrc && !/\.update\(/.test(fnSrc), 'retryDunningPayment() makes no .update() call');
ok(!/dunning_status\s*:\s*['"]retried['"]/.test(html), "the page never writes dunning_status 'retried'");
ok(!!fnSrc && /\.rpc\(\s*['"]request_dunning_retry['"]\s*,\s*\{\s*p_failure_id\s*:/.test(fnSrc), 'it calls request_dunning_retry with p_failure_id only');
ok(/id="dunningRetryStatus"/.test(html), 'the status line element exists');

function makeEl(id) { return { id, style: {}, textContent: '', disabled: false }; }
async function click({ rpc }) {
  const els = new Map();
  const doc = { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); } };
  const calls = [];
  const sb = { rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); },
               from() { throw new Error('direct table access is not allowed'); } };
  const warns = [];
  const ctx = { document: doc, sb, console: { warn: (...a) => warns.push(a), log() {}, error() {} }, Object, activeDunningRecord: { id: 'FAILURE-ID-FIXTURE' } };
  vm.createContext(ctx);
  vm.runInContext(msgSrc + '\n' + fnSrc + '\nthis.retryDunningPayment = retryDunningPayment;', ctx);
  await ctx.retryDunningPayment();
  return { calls, btn: doc.getElementById('dunningRetryBtn'), st: doc.getElementById('dunningRetryStatus'), warns };
}
// the shim's getElementById creates elements on demand, so the button and status line exist even if the page lacks them;
// the id check above covers the page.

let r = await click({ rpc: async () => ({ data: { status: 'requested', retry_requested_at: 'x' }, error: null }) });
ok(r.calls.length === 1 && r.calls[0].name === 'request_dunning_retry' && r.calls[0].args.p_failure_id === 'FAILURE-ID-FIXTURE' && Object.keys(r.calls[0].args).length === 1, 'requested: one rpc call, the failure id only');
ok(/Retry requested/.test(r.st.textContent) && r.st.style.display === 'block', 'requested: shows the requested message');
ok(r.btn.disabled === true && r.btn.textContent === 'Retry requested', 'requested: button stays disabled and says so');

r = await click({ rpc: async () => ({ data: { status: 'already_requested', retry_requested_at: 'x' }, error: null }) });
ok(/already requested/.test(r.st.textContent) && r.btn.disabled === true, 'already_requested: shows the existing-request message');

r = await click({ rpc: async () => ({ data: { status: 'not_retryable', retry_requested_at: null }, error: null }) });
ok(/no longer be retried/.test(r.st.textContent) && r.btn.textContent === 'Retry unavailable' && r.btn.disabled === true, 'not_retryable: says so and points to Update Card');

r = await click({ rpc: async () => ({ data: null, error: { message: 'payment failure not found', code: '42501' } }) });
ok(/could not request/.test(r.st.textContent) && r.btn.disabled === false && r.btn.textContent === 'Retry Payment Now', 'rpc error: visible error text, button re-enabled');

r = await click({ rpc: async () => ({ data: { status: 'something_else' }, error: null }) });
ok(/could not request/.test(r.st.textContent) && r.btn.disabled === false, 'unknown status: treated as an error, never as success');

r = await click({ rpc: async () => ({ data: null, error: null }) });
ok(/could not request/.test(r.st.textContent) && r.btn.disabled === false, 'empty result: treated as an error, never as success');

r = await click({ rpc: async () => { throw new Error('network'); } });
ok(/could not request/.test(r.st.textContent) && r.btn.disabled === false, 'thrown error: visible error text, button re-enabled');

// the click does nothing without an active failure record
{
  const ctx = { document: { getElementById: () => makeEl('x') }, sb: { rpc: async () => { throw new Error('must not be called'); } }, console, Object, activeDunningRecord: null };
  vm.createContext(ctx);
  vm.runInContext(msgSrc + '\n' + fnSrc + '\nthis.retryDunningPayment = retryDunningPayment;', ctx);
  let threw = false; try { await ctx.retryDunningPayment(); } catch { threw = true; }
  ok(!threw, 'no active failure record: returns without calling the server');
}

// the migration set is filed and says what the page relies on
const mig = fs.readFileSync(path.join(root, 'supabase/migrations_drafts/gh2442_dunning_retry_request.sql'), 'utf8');
ok(/CREATE OR REPLACE FUNCTION public\.request_dunning_retry\(p_failure_id uuid\)/.test(mig) && /SECURITY DEFINER/.test(mig) && /SET search_path = public, pg_temp/.test(mig), 'migration defines request_dunning_retry as SECURITY DEFINER with a pinned search_path');
ok(!/EXECUTE\s+(format|')/i.test(mig.replace(/^--.*$/gm, '')), 'migration function uses no dynamic SQL');
ok(/GRANT EXECUTE ON FUNCTION public\.request_dunning_retry\(uuid\) TO authenticated;/.test(mig) && !/TO\s+(anon|PUBLIC)\s*;/.test(mig.replace(/^--.*$/gm, '')), 'migration grants EXECUTE to authenticated only');
ok(/REVOKE UPDATE, TRUNCATE, TRIGGER ON public\.payment_failures FROM anon;/.test(mig), 'migration revokes the anon write grants');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
