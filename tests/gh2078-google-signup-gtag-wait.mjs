/**
 * gh-2078 PR #2092 review fix 2 — partner-insurance.html's Google-link
 * partner signup completion used to call `gtag(...)` and immediately
 * `window.location.replace(...)`. js/ga-gate.js's `gtag()` stub always
 * exists synchronously (pushes to `dataLayer` immediately), but the REAL
 * gtag.js library that reads that queue and actually sends a hit loads
 * deferred (idle, or a 1500ms fallback — see js/ga-gate.js's own comment).
 * A page teardown inside that window drops the queued event entirely.
 *
 * `gtagEventAndWait()` (extracted verbatim from partner-insurance.html, not
 * reimplemented — same pattern as tests/gh2078-partner-signup-complete.mjs)
 * fixes this by racing gtag's own `event_callback` against a bounded
 * timeout before the caller navigates.
 *
 * LABEL: a Node vm + DOM-shim result, not a real-browser result.
 *
 * Run: node tests/gh2078-google-signup-gtag-wait.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let failures = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`✓ PASS: ${label}`);
  } else {
    console.log(`✗ FAIL: ${label}`);
    failures++;
  }
}

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

async function main() {
  const src = fs.readFileSync(path.join(repoRoot, 'partner-insurance.html'), 'utf8');
  const fnSrc = extractFunction(src, 'gtagEventAndWait');

  ok(fnSrc.length > 0, 'gtagEventAndWait() found in partner-insurance.html');
  ok(/event_callback/.test(fnSrc), 'uses event_callback (waits for gtag.js to actually send, not just queue)');
  ok(/setTimeout/.test(fnSrc), 'has a bounded timeout fallback -- never waits forever for a gtag.js that never loads');

  // ── Scenario 1: gtag.js has already loaded — event_callback fires quickly ──
  {
    const calls = [];
    const sandbox = { setTimeout, clearTimeout, Promise, console };
    sandbox.gtag = (...args) => {
      calls.push(args);
      const cb = args[2] && args[2].event_callback;
      if (typeof cb === 'function') setTimeout(cb, 5); // simulate a fast, already-loaded gtag.js
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nthis.__f = gtagEventAndWait;', sandbox, { filename: 'partner-insurance.html' });
    const queued = await sandbox.__f('partner_signup_complete', { variant: 'e' }, 1000);
    ok(queued === true, 'resolves true promptly when event_callback fires before the timeout');
    ok(calls.length === 1 && calls[0][0] === 'event' && calls[0][1] === 'partner_signup_complete', 'calls gtag(\'event\', name, payload)');
    ok(calls[0][2].variant === 'e', 'forwards the caller\'s params unchanged (plus event_callback)');
  }

  // ── Scenario 2: gtag.js NEVER loads this pageload — event_callback never fires ──
  {
    let resolvedAt = null;
    const start = Date.now();
    const sandbox = { setTimeout, clearTimeout, Promise, console };
    sandbox.gtag = () => {
      /* real gtag.js never loads on this run -- event_callback is never invoked */
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nthis.__f = gtagEventAndWait;', sandbox, { filename: 'partner-insurance.html' });
    const queued = await sandbox.__f('partner_signup', { method: 'google' }, 50);
    resolvedAt = Date.now() - start;
    ok(queued === true, 'still resolves true on timeout — dataLayer.push already ran synchronously, so it is durably queued');
    ok(resolvedAt >= 45, `waited roughly the full timeout before resolving (${resolvedAt}ms >= ~50ms)`);
  }

  // ── Scenario 3: gtag itself throws synchronously — nothing was queued ──
  {
    const sandbox = { setTimeout, clearTimeout, Promise, console };
    sandbox.gtag = () => {
      throw new Error('gtag stub unavailable');
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nthis.__f = gtagEventAndWait;', sandbox, { filename: 'partner-insurance.html' });
    const queued = await sandbox.__f('partner_signup_complete', { variant: 'd' }, 1000);
    ok(queued === false, 'resolves false when the synchronous gtag(...) call itself throws');
  }

  // ── Regression: the call site actually awaits both events before navigating ──
  {
    const idx = src.indexOf('await gtagEventAndWait(\'partner_signup\'');
    ok(idx !== -1, 'call site awaits gtagEventAndWait for partner_signup (Google-link path)');
    const idx2 = src.indexOf("await gtagEventAndWait('partner_signup_complete'");
    ok(idx2 !== -1, 'call site awaits gtagEventAndWait for partner_signup_complete (Google-link path)');
    const navIdx = src.indexOf("window.location.replace('/partner-dashboard.html')", idx2);
    ok(navIdx !== -1 && navIdx > idx && navIdx > idx2, 'the navigation happens AFTER both awaited calls, not before');
  }

  // ── partner-re.html has no Google OAuth signup path — nothing to fix there ──
  {
    const reSrc = fs.readFileSync(path.join(repoRoot, 'partner-re.html'), 'utf8');
    ok(!/signInWithGoogle/.test(reSrc), 'partner-re.html has no Google OAuth signup call site (confirms the fix only applies to partner-insurance.html)');
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main();
