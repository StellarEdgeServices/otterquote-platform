/**
 * gh-2155 HI-0c -- parity test for partner-agreement-inspector.html.
 *
 * Ben's ruling (#2152 comment 5836510515, item 1) requires a static
 * partner-agreement-inspector.html generated from partner-agreement.html by
 * a script, PLUS a test that regenerates it and asserts byte-equality with
 * the committed file, so the two can never silently drift apart.
 *
 * This test:
 *   1. Regenerates the inspector agreement from the CURRENT
 *      partner-agreement.html (via tools/build_inspector_agreement.py
 *      --stdout) and asserts it is byte-identical to the committed
 *      partner-agreement-inspector.html (drift check).
 *   2. Asserts the four removed sections are absent from the committed file
 *      (fee table, Section 4.1, all of Section 7, the Section 14(a)
 *      cross-reference).
 *   3. Asserts everything else is present and unchanged -- every other
 *      section heading, the footer/legal boilerplate, and Section 4.3's
 *      no-fee statement (which must survive; it is NOT one of the removed
 *      elements).
 *
 * Run: node tests/gh2155-hi0c-inspector-agreement-parity.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const SOURCE_PATH = path.join(repoRoot, 'partner-agreement.html');
const OUTPUT_PATH = path.join(repoRoot, 'partner-agreement-inspector.html');
const BUILD_SCRIPT = path.join(repoRoot, 'tools', 'build_inspector_agreement.py');

function findPython() {
  const candidates = ['python', 'python3', 'py'];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return cmd;
    } catch (_) { /* try next */ }
  }
  throw new Error('No python interpreter found on PATH (tried python, python3, py).');
}

const PYTHON = findPython();

// ── 1. Drift check: fresh build must byte-match the committed file ────────
const committed = fs.readFileSync(OUTPUT_PATH, 'utf8');
const freshBuild = execFileSync(PYTHON, [BUILD_SCRIPT, '--stdout'], { cwd: repoRoot, encoding: 'utf8' });
ok(freshBuild === committed, 'partner-agreement-inspector.html matches a fresh build from partner-agreement.html (no drift)');

// The --check flag should independently agree.
let checkExitCode = 0;
try {
  execFileSync(PYTHON, [BUILD_SCRIPT, '--check'], { cwd: repoRoot, stdio: 'pipe' });
} catch (err) {
  checkExitCode = err.status;
}
ok(checkExitCode === 0, 'tools/build_inspector_agreement.py --check exits 0 (agrees with the drift check above)');

// Rendered text never includes HTML comments (a browser's DOM/innerText
// does not render them) -- strip them before checking for removed markers,
// so a marker mentioned only inside an explanatory comment (e.g. the
// Section 4 heading's own comment, which still says "$200/$50 table" when
// describing what USED to be hidden there) does not produce a false FAIL.
const renderedOnly = committed.replace(/<!--[\s\S]*?-->/g, '');

const removedMarkers = [
  ['$200', 'the $200 Referral Fee amount'],
  ['$50', 'the $50 Recruit Bonus amount'],
  ['$10,000 Floor', 'the $10,000 Floor fee-table paragraph'],
  ['4.1 Single-Level Recruiting (D-140)', 'Section 4.1 heading'],
  ['The Recruit Bonus is', 'Section 4.1 body (single-level/forward-only recruiting rule)'],
  ['7. Licensing and Employment Compliance Disclaimer', 'Section 7 heading'],
  ['Mandatory Disclaimer', 'the D-266 disclaimer box'],
  ['make sure it is lawful for you to accept referral fees', 'the D-266 lawful-to-accept sentence'],
  ['including the representation in Section 7', 'the Section 14(a) cross-reference to Section 7'],
];
for (const [marker, label] of removedMarkers) {
  ok(!renderedOnly.includes(marker), `removed: ${label} ("${marker}") is absent from partner-agreement-inspector.html's rendered text`);
}

// ── 3. Everything else survives ────────────────────────────────────────────
const survivingMarkers = [
  ['Partner Referral Agreement', 'the page title/H1'],
  ['v3-2026-09', 'the agreement version stamp'],
  ['1. Acceptance of Agreement', 'Section 1'],
  ['2. Independent Contractor Relationship', 'Section 2'],
  ['3. Scope of Referral Services', 'Section 3'],
  ['4. Referral Fee Structure', 'the Section 4 heading (kept -- only its fee sub-content is removed)'],
  ['4.2 Payment Timing', 'Section 4.2 (generic payment timing, kept)'],
  ['4.3 Home Inspector Partners', 'Section 4.3 (the no-fee statement itself, kept)'],
  ['receives no Referral Fee and no Recruit Bonus', 'the Section 4.3 no-fee sentence text'],
  ['5. Payment Method', 'Section 5'],
  ['6. Tax Treatment', 'Section 6'],
  ['8. No Solicitation of Homeowners', 'Section 8'],
  ['14. Indemnification', 'the Section 14 heading (kept -- only the (a) cross-reference phrase is removed)'],
  ['15. Disputes', 'Section 15'],
  ['19. Contact Information', 'Section 19'],
  ['site-footer', 'the shared footer mount point'],
  ['js/nav.js', 'the shared nav script tag'],
];
for (const [marker, label] of survivingMarkers) {
  ok(committed.includes(marker), `kept: ${label} ("${marker}") is present in partner-agreement-inspector.html`);
  ok(fs.readFileSync(SOURCE_PATH, 'utf8').includes(marker), `sanity: ${label} is also present in the source partner-agreement.html`);
}

// This exact phrase only EXISTS after the Section 14(a) span removal joins
// "...this Agreement" directly to "; (b) any violation..." -- it is not a
// substring of the (unmodified) source, so it is checked on its own,
// without the source sanity-check the loop above applies to every other
// marker.
ok(renderedOnly.includes('Partner&rsquo;s breach of this Agreement; (b) any violation'),
  'kept: Section 14(a)/(b) reads cleanly with the cross-reference span removed');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
