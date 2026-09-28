/**
 * gh-2296 / gh-2298 (k74-w-2295, aawb-i-2298) — regression test for
 * partner-app-install-ios.html's updated iOS 26 Add to Home Screen flow.
 *
 * Problem: iOS 26 (shipped Sept 2025, MacRumors 2025-08-20) moved Safari's
 * Share icon behind a new ••• (more) button and added an "Open as Web App"
 * toggle inside Add to Home Screen, ON by default (iDownloadBlog,
 * 2025-06-17) -- turning it off yields a plain Safari bookmark, not a
 * standalone-launching app. This page's steps predated that change.
 * iOS 27 / iPadOS 27 shipped 2026-09-14 (AppleInsider, 2026-09-09); the flow
 * is believed unchanged there per MacRumors' "iOS 27: All the New Safari
 * Features" guide (no Add to Home Screen / Open as Web App changes listed),
 * but that has not been independently device-verified -- treated as
 * unverified in the page's HTML comment and PR body.
 *
 * Static, source-level checks only (same pattern this repo uses for
 * copy-wording regressions, e.g. tests/gh2068-*): the step list must mention
 * the ••• menu before Share (with a fallback for devices without it), the
 * "Open as Web App" toggle being ON, and must NOT regress to a step 2 that
 * drops the ••• menu entirely.
 *
 * Run: node tests/gh2296-partner-app-install-ios-flow.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(repoRoot, 'partner-app-install-ios.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const stepListStart = pageSrc.indexOf('<ol class="step-list">');
const stepListEnd = pageSrc.indexOf('</ol>', stepListStart);
ok(stepListStart !== -1 && stepListEnd !== -1, 'source: <ol class="step-list"> block found');
const stepList = pageSrc.slice(stepListStart, stepListEnd);
// Tag-stripped view for assertions that need to match phrases split across
// inline markup (e.g. "is <strong>ON</strong>").
const stepListText = stepList.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

ok(/&#8226;&#8226;&#8226;/.test(stepList) || /•••/.test(stepList),
  'iOS 26: steps mention the ••• (more) button in the address bar');
ok(/Open as Web App/.test(stepList),
  'iOS 26: steps mention the new "Open as Web App" toggle');
ok(/toggle\s+ON|ON\s+the.*toggle|Turn ON|toggle\s+is\s+ON|\bis\s+ON\b/i.test(stepListText),
  'iOS 26: steps confirm the toggle is/should be ON, not just mention its name');
ok(/Add to Home Screen/.test(stepList),
  'steps still mention Add to Home Screen (unchanged step, still required)');

// Regression guard: the pre-26 flow tapped Share directly with no mention of
// a ••• menu first. Assert the ••• menu is still step 2's PRIMARY path (not
// merely absent everywhere, since "Share" legitimately still appears after
// the ••• tap) -- but allow, and require, a fallback clause for devices
// without an address-bar ••• button (e.g. iOS 18 and earlier, or iPad).
const step2Match = stepList.match(/<span class="step-num">2<\/span>\s*<span class="step-text">([\s\S]*?)<\/span>\s*<\/li>/);
ok(!!step2Match, 'source: step 2 found');
if (step2Match) {
  const step2Text = step2Match[1];
  ok(/•••|&#8226;/.test(step2Text),
    'regression guard: step 2 requires the ••• menu as the primary path (a fallback clause is allowed alongside it)');
  ok(/Don.t see|directly/i.test(step2Text) && /Share/.test(step2Text),
    'step 2 includes fallback guidance to tap Share directly when there is no ••• button');
}

// Number of steps grew by one (the new toggle step) -- 6 steps now, not 5.
const stepNums = [...stepList.matchAll(/<span class="step-num">(\d+)<\/span>/g)].map((m) => Number(m[1]));
ok(stepNums.length === 6 && stepNums.join(',') === '1,2,3,4,5,6',
  `source: exactly 6 sequential steps (got: ${stepNums.join(',')})`);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
