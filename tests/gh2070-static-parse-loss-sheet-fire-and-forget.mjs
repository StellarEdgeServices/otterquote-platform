/**
 * gh-2070 (static twin) — dashboard.html:~3138's `await
 * sb.functions.invoke('parse-loss-sheet', ...)` must be fire-and-forget, not
 * awaited. Mirrors the fix already landed for two other call sites (PR
 * #2080 for trade-selector's stub, PR #2208 for the React dashboard's
 * uploadClaimDocument): `parse-loss-sheet` makes a synchronous,
 * non-streaming Claude vision call routinely taking 15-60s, bounded only by
 * the ~150s Edge Function wall clock, so an awaited invoke here can hang
 * the upload UI indefinitely. A `catch` handles a rejection, not a latency
 * — so the invoke must not be awaited at all.
 *
 * This loads the real parse-loss-sheet call site out of dashboard.html into
 * a vm context with a fake `sb.functions.invoke` that never settles, and
 * asserts the surrounding async function still resolves promptly — the
 * same "never settles" shape used by the React-side regression tests
 * (gh2070-parse-fire-and-forget.test.ts on PR #2208).
 *
 * Run: node tests/gh2070-static-parse-loss-sheet-fire-and-forget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

// ---- static shape check: the call must not be `await`ed ----
const callMatch = dashboardSrc.match(
  /if \(type === 'estimate' && uploadedStoragePath\) \{[\s\S]*?\n\s{12}\}\n/
);
ok(!!callMatch, 'dashboard.html: the estimate-upload parse-loss-sheet call site parses as a single block');
const block = callMatch ? callMatch[0] : '';
ok(!/await\s+sb\.functions\.invoke\(\s*['"]parse-loss-sheet['"]/.test(block),
  'dashboard.html: parse-loss-sheet invoke is no longer awaited');
ok(/void\s+sb\.functions\.invoke\(\s*['"]parse-loss-sheet['"][\s\S]*?\.catch\(/.test(block),
  'dashboard.html: parse-loss-sheet is called as void ...invoke(...).catch(...) (fire-and-forget)');

// ---- behavioural check: a never-settling invoke must not hang the caller ----
// Extract the block into a standalone async function against a fake `sb`.
async function runBehaviouralCheck() {
  const fnSrc = `
    async function uploadEstimateStep(sb, type, uploadedStoragePath, currentClaim) {
      ${block}
      return 'done';
    }
    module.exports = uploadEstimateStep;
  `;
  const vm = await import('node:vm');
  const Module = (await import('node:module')).default;
  const m = new Module(path.join(ROOT, '__gh2070_extract__.js'));
  m._compile(fnSrc, path.join(ROOT, '__gh2070_extract__.js'));
  const uploadEstimateStep = m.exports;

  let invoked = false;
  const neverSettles = () => { invoked = true; return new Promise(() => {}); }; // never resolves/rejects
  const sb = { functions: { invoke: (...args) => neverSettles(...args) } };

  const timeoutMs = 1500;
  const race = Promise.race([
    uploadEstimateStep(sb, 'estimate', 'u/c/estimate.pdf', { id: 'claim1' }).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), timeoutMs)),
  ]);
  const outcome = await race;
  ok(invoked, 'behavioural: the fake parse-loss-sheet invoke was actually called');
  ok(outcome === 'resolved', `behavioural: caller resolves promptly even when parse-loss-sheet never settles (got "${outcome}")`);
}

await runBehaviouralCheck().catch((e) => {
  failed++;
  console.log('FAIL: behavioural check threw: ' + (e && e.stack || e));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
