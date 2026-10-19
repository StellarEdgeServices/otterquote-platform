/**
 * gh-2442 -- the contractor "Retry Payment Now" button.
 * Runs the REAL retryDunningPayment() lifted from contractor-dashboard.html against a fake Supabase client.
 *   - it must ask the server (rpc request_dunning_retry) and must never touch payment_failures directly;
 *   - Ben's card-fee sentence (6258735566) must be on the retry banner, byte for byte equal to
 *     contractor-settings.html:1311 (read from the file, not retyped here).
 * Negative control: HTML_PATH=<main's contractor-dashboard.html> node tests/gh2442-dunning-retry-button.mjs  (must FAIL)
 * Run: node tests/gh2442-dunning-retry-button.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = process.env.HTML_PATH || path.join(root, 'contractor-dashboard.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const settings = fs.readFileSync(process.env.SETTINGS_PATH || path.join(root, 'contractor-settings.html'), 'utf8');

let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

// ── the sentence: read from contractor-settings.html:1311 (1-based), never retyped
const sentence = settings.split('\n')[1310].trim();
ok(sentence.startsWith('Credit and debit card payments include a small processing fee'), 'settings line 1311 is the card-fee sentence');
ok(html.includes('>' + sentence + '</p>'), 'dashboard retry banner carries the sentence byte for byte');
const bannerStart = html.indexOf('id="dunningAlertBanner"');
const bannerEnd = html.indexOf('Bid Accepted Notification Banner');
ok(bannerStart > 0 && html.slice(bannerStart, bannerEnd).includes(sentence), 'the sentence sits inside the dunning banner');
ok(html.split(sentence).length === 2, 'the sentence appears exactly once on the dashboard');

// ── lift the real function
const start = html.indexOf('async function retryDunningPayment() {');
ok(start > 0, 'retryDunningPayment exists');
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = html.slice(start, end);
ok(!/\.from\(\s*['"]payment_failures['"]\s*\)/.test(fnSrc), 'no direct payment_failures table access in the click handler');
ok(/\.rpc\(\s*['"]request_dunning_retry['"]/.test(fnSrc), 'click handler calls rpc request_dunning_retry');

function makeRun({ rpcResult, rpcError, throwOnFrom }) {
  const calls = { rpc: [], from: [], alerts: [], warns: 0 };
  const btn = { disabled: false, textContent: 'Retry Payment Now' };
  const banner = { style: { display: 'flex' } };
  const sb = {
    rpc: async (name, args) => { calls.rpc.push([name, args]); return { data: rpcResult, error: rpcError || null }; },
    from: (t) => { calls.from.push(t); if (throwOnFrom) throw new Error('direct table access'); return { update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }; },
  };
  const document = { getElementById: (id) => (id === 'dunningRetryBtn' ? btn : id === 'dunningAlertBanner' ? banner : null) };
  const state = { activeDunningRecord: { id: 'f-1' } };
  const factory = new Function('sb', 'document', 'console', 'alert', 'state',
    `let activeDunningRecord = state.activeDunningRecord; ${fnSrc}; return retryDunningPayment;`);
  const fn = factory(sb, document, { warn() { calls.warns++; } }, (m) => calls.alerts.push(m), state);
  return { fn, calls, btn, banner };
}

{ const r = makeRun({ rpcResult: { status: 'requested', reason: null } }); await r.fn();
  ok(r.calls.rpc.length === 1 && r.calls.rpc[0][0] === 'request_dunning_retry' && r.calls.rpc[0][1].p_failure_id === 'f-1', 'requested: one rpc with the failure id');
  ok(r.calls.from.length === 0, 'requested: no table access');
  ok(r.banner.style.display === 'flex', 'requested: banner stays (only a server-side charge clears it)');
  ok(r.btn.disabled === true, 'requested: button stays disabled (request on file)');
  ok(r.calls.alerts.length === 0, 'requested: no error alert'); }
{ const r = makeRun({ rpcResult: { status: 'already_requested', reason: null } }); await r.fn();
  ok(r.btn.disabled === true && r.calls.alerts.length === 0, 'already_requested: treated as on file'); }
{ const r = makeRun({ rpcResult: { status: 'not_retryable', reason: 'homeowner_notified' } }); await r.fn();
  ok(r.btn.disabled === false && r.btn.textContent === 'Retry Payment Now', 'not_retryable: button re-enabled');
  ok(r.calls.alerts.length === 1 && r.calls.alerts[0] === 'An error occurred. Please try again.', 'not_retryable: shows the page\'s existing generic error string, no new wording');
  ok(r.banner.style.display === 'flex', 'not_retryable: banner stays'); }
{ const r = makeRun({ rpcResult: null, rpcError: { message: 'permission denied' } }); await r.fn();
  ok(r.btn.disabled === false && r.calls.alerts.length === 1, 'rpc error: button re-enabled and the generic error shown'); }
{ const r = makeRun({ rpcResult: null }); await r.fn();
  ok(r.btn.disabled === false && r.calls.alerts.length === 1, 'empty result: never looks like success'); }
{ const r = makeRun({ rpcResult: { status: 'surprise' } }); await r.fn();
  ok(r.btn.disabled === false && r.calls.alerts.length === 1, 'unknown status: never looks like success'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
