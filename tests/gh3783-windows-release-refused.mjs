/**
 * gh-3783 (D-375) -- a claim that includes windows is never released to contractors from dashboard.html.
 * Extracts submitForBids from the page and runs it against a recording stub of the Supabase client.
 * Run: node tests/gh3783-windows-release-refused.mjs     GH3783_ROOT=<another tree> for a negative control (a checkout of main fails).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GH3783_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const m = html.match(/async function submitForBids\(\)[\s\S]*?\n      \}\n(?=\s*\n\s*\/\/ ── Notifications)/);
ok(!!m, 'submitForBids found in dashboard.html');

async function run(trades, extra = {}) {
  const calls = { updates: [], invokes: [], errors: [] };
  const sb = {
    from: () => ({ update: (u) => { calls.updates.push(u); return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'c1' }], error: null }) }) }; } }),
    functions: { invoke: (n) => { calls.invokes.push(n); return Promise.resolve({}); } },
  };
  const el = () => ({ style: {}, classList: { add() {}, remove() {} }, disabled: false, textContent: '' });
  const factory = new Function('sb', 'currentClaim', 'calls', 'document', 'CONFIG',
    `let submitInFlight = false;
     const waitForEstimateRead = async () => {};
     const updateStatusBanner = async () => {};
     const BID_OPEN_REFUSAL_TEXT = 'x';
     function isBidOpenRefusal() { return false; }
     function showError(msg) { calls.errors.push(msg); }
     ${m ? m[0] : 'async function submitForBids(){ throw new Error("missing"); }'}
     return submitForBids;`);
  const claim = { id: 'c1', trades, ...extra };
  const fn = factory(sb, claim, calls, { getElementById: el }, { DEMO_MODE: false });
  await fn();
  return calls;
}

if (m) {
  const w = await run(['windows']);
  ok(w.updates.length === 0 && w.invokes.length === 0, 'windows-only: no claims update, no notify-contractors');
  ok(w.errors.length === 1 && w.errors[0] === 'Coming Soon', 'windows-only: shows the existing "Coming Soon" text');
  const mixed = await run(['roofing', 'windows']);
  ok(mixed.updates.length === 0 && mixed.invokes.length === 0, 'roofing+windows (mixed): refused, no claims update, no notify-contractors');
  ok(mixed.errors.length === 1 && mixed.errors[0] === 'Coming Soon', 'roofing+windows (mixed): shows the existing "Coming Soon" text');
  const upper = await run(['Roofing', 'WINDOWS']);
  ok(upper.updates.length === 0, 'case-insensitive: Roofing+WINDOWS refused');
  const r = await run(['roofing']);
  ok(r.updates.length === 1 && !!r.updates[0].roofing_bid_released_at && r.invokes.length === 1, 'roofing-only: released and contractors notified (positive control)');
  const g = await run(['roofing', 'gutters']);
  ok(!!g.updates[0].gutters_bid_released_at, 'roofing+gutters: gutters still released');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
