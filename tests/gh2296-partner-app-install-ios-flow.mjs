/**
 * gh-2296 (k74-w-2295) — regression test for partner-app-install-ios.html's
 * updated iOS 26 Add to Home Screen flow.
 *
 * Problem: iOS 26 (shipped Sept 2026) moved Safari's Share icon behind a new
 * ••• (more) button and added a required "Open as Web App" toggle inside
 * Add to Home Screen -- without it, the result is a plain Safari bookmark,
 * not a standalone-launching app. This page's steps predated that change.
 * Source: MacRumors iOS 26 coverage, cited in issue #2296.
 *
 * Static, source-level checks only (same pattern this repo uses for
 * copy-wording regressions, e.g. tests/gh2068-*): the step list must mention
 * the ••• menu before Share, the "Open as Web App" toggle, and must NOT
 * regress to the old direct-Share-icon-first wording.
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

ok(/&#8226;&#8226;&#8226;/.test(stepList) || /•••/.test(stepList),
  'iOS 26: steps mention the ••• (more) button in the address bar');
ok(/Open as Web App/.test(stepList),
  'iOS 26: steps mention the new "Open as Web App" toggle');
ok(/toggle\s+ON|ON\s+the.*toggle|Turn ON/i.test(stepList),
  'iOS 26: steps say to turn the toggle ON, not just mention its name');
ok(/Add to Home Screen/.test(stepList),
  'steps still mention Add to Home Screen (unchanged step, still required)');

// Regression guard: the pre-26 flow tapped Share directly with no mention of
// a ••• menu first. Assert the OLD single-step wording is gone from step 2
// specifically (not merely absent everywhere, since "Share" legitimately
// still appears after the ••• tap).
const step2Match = stepList.match(/<span class="step-num">2<\/span>\s*<span class="step-text">([\s\S]*?)<\/span>\s*<\/li>/);
ok(!!step2Match, 'source: step 2 found');
if (step2Match) {
  const step2Text = step2Match[1];
  ok(/•••|&#8226;/.test(step2Text),
    'regression guard: step 2 requires the ••• menu, not a direct Share tap');
}

// Number of steps grew by one (the new toggle step) -- 6 steps now, not 5.
const stepNums = [...stepList.matchAll(/<span class="step-num">(\d+)<\/span>/g)].map((m) => Number(m[1]));
ok(stepNums.length === 6 && stepNums.join(',') === '1,2,3,4,5,6',
  `source: exactly 6 sequential steps (got: ${stepNums.join(',')})`);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
