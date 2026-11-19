/**
 * gh-3493 -- ratchet: any code that calls the `switch-contractor` Edge Function must carry the
 * in-flight guard marker `GH3493-INFLIGHT-GUARD` in the same file.
 *
 * THE RULE (issue #3493, Ben's ruling, comment 6689708951, condition 2): the control that submits a
 * switch must be DISABLED while a switch request is in flight, and the losing (duplicate) request keeps
 * the existing error text. The server already refuses the second request (PR #3509); the page must not
 * invite it.
 *
 * Today nothing calls the function (dashboard.html's switch button sends a support email instead), so
 * this passes with zero callers. The day someone wires a caller, this fails until that file carries the
 * marker comment, which the person wiring it writes after reading the rule above.
 *
 * HONEST LIMIT: the marker proves only that the person wiring the caller was pointed at the rule. It does
 * NOT prove the guard works. A behavioural test (submit twice, assert one request is sent and the button
 * is disabled in between) is owed together with the wiring PR.
 *
 * Scanned: .html (script blocks, plus any "functions/v1/switch-contractor" URL), and .js/.mjs/.cjs/.jsx/.ts/.tsx
 * across the repo. Skipped: the function's own directory, tests, __tests__, *.test.*, node_modules, .next, .git, Archive.
 * Detected as a call: a "functions/v1/switch-contractor" URL; invoke('switch-contractor'...); or the name as a
 * quoted string literal (a constant or config that holds the name).
 *
 * Run: node tests/gh3493-switch-contractor-caller-guard.mjs   (exits non-zero on failure)
 * GH3493_ROOT points at another tree (negative control / throwaway caller).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH3493_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'GH3493-INFLIGHT-GUARD';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'tests', '__tests__', 'Archive', 'handoffs']);
const OWN_DIR = 'supabase/functions/switch-contractor';
const EXT = /\.(html|js|mjs|cjs|jsx|ts|tsx)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const URL_RE = /functions\/v1\/switch-contractor(?![\w-])/;
const INVOKE_RE = /invoke\(\s*[`"']switch-contractor[`"']/;
const LITERAL_RE = /[`"']switch-contractor[`"']/;

function* walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || rel === OWN_DIR) continue;
      yield* walk(rel);
    } else if (EXT.test(e.name) && !TEST_FILE.test(e.name)) {
      yield rel;
    }
  }
}

function callsSwitchContractor(rel, text) {
  if (URL_RE.test(text) || INVOKE_RE.test(text)) return true;
  if (rel.endsWith('.html')) {
    // HTML prose may quote the name (terms.html does); only script bodies count as code.
    const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
    return LITERAL_RE.test(scripts);
  }
  return LITERAL_RE.test(text);
}

const callers = [];
let scanned = 0;
for (const rel of walk('')) {
  scanned++;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (callsSwitchContractor(rel, text)) callers.push({ rel, marked: text.includes(MARKER) });
}

let failed = 0;
console.log(`scanned ${scanned} source files; ${callers.length} caller(s) of switch-contractor found`);
if (callers.length === 0) console.log('PASS: no page or script calls switch-contractor yet (nothing to guard)');
for (const c of callers) {
  if (c.marked) {
    console.log(`PASS: ${c.rel} calls switch-contractor and carries ${MARKER}`);
  } else {
    failed++;
    console.log(
      `FAIL: ${c.rel} calls the switch-contractor Edge Function without the ${MARKER} marker.\n` +
      '  Rule (issue #3493, comment 6689708951): the control that submits a switch must be DISABLED while a\n' +
      '  switch request is in flight, and the losing (duplicate) request keeps the existing error text.\n' +
      '  Read that comment, implement the guard, add a behavioural test for it, then put a comment containing\n' +
      `  ${MARKER} next to the guard in this file. (The marker proves you read the rule, not that the guard works.)`
    );
  }
}
process.exit(failed ? 1 : 0);
