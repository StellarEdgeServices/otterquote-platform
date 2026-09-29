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
 *   4. (HI-0d, D-333) Asserts Section 4 is re-headed "4. No Referral Fee or
 *      Recruit Bonus" with only the verbatim 4.3 statement, and FAILS if
 *      "Referral Fee Structure" or "4.2 Payment Timing" appears in the
 *      inspector output. The test's build script is overridable via the
 *      INSPECTOR_BUILD_SCRIPT env var (used only for a negative control).
 *
 *   5. (HI-0e, D-333, Ben ruling 5882085491 on #2155, "STRIP IT.") Asserts the
 *      fee-payment mechanics are gone from the inspector build -- all of
 *      Section 5 (Venmo/PayPal payout text) and Section 10 (Commission
 *      Reversal), the Section 9 "earned only on jobs" sentence, the meta/og
 *      "commission terms" -- with NO renumbering, NO new words, the source
 *      partner-agreement.html still carrying every one of them, and the
 *      word "commission" surviving ONLY inside the exact mixed-obligation
 *      sentences Ben must rule on (KEPT_AMBIGUOUS below).
 *
 * Run: node tests/gh2155-hi0c-inspector-agreement-parity.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// gh-2354 / D-341 pinned sentences (Section 13 liability cap).
const D341_CAP_OLD = 'SHALL NOT EXCEED THE TOTAL COMMISSIONS PAID TO PARTNER IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.';
const D341_CAP_NEW = 'SHALL NOT EXCEED THE GREATER OF TOTAL COMMISSIONS PAID TO PARTNER IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR $100.';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const SOURCE_PATH = path.join(repoRoot, 'partner-agreement.html');
// INSPECTOR_HTML_PATH is overridable only for negative controls (gh-2354).
const OUTPUT_PATH = process.env.INSPECTOR_HTML_PATH || path.join(repoRoot, 'partner-agreement-inspector.html');
const BUILD_SCRIPT = process.env.INSPECTOR_BUILD_SCRIPT || path.join(repoRoot, 'tools', 'build_inspector_agreement.py');

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
  ['receives no Referral Fee and no Recruit Bonus', 'the Section 4.3 no-fee sentence text'],
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

// ── 4. gh-2155 HI-0d (D-333, Ben ruling on PR #2312): Section 4 ─────────────
// The inspector build must emit Section 4 as the heading
// "4. No Referral Fee or Recruit Bonus" containing ONLY the verbatim 4.3
// Home Inspector Partners statement copied from the source. The fee heading
// and the 4.2 Payment Timing paragraph must NOT appear anywhere in the output.
const sourceText = fs.readFileSync(SOURCE_PATH, 'utf8');
ok(!committed.includes('Referral Fee Structure'), 'D-333: "Referral Fee Structure" does not appear anywhere in the committed inspector agreement');
ok(!freshBuild.includes('Referral Fee Structure'), 'D-333: "Referral Fee Structure" does not appear in the freshly built inspector output');
ok(!committed.includes('4.2 Payment Timing'), 'D-333: "4.2 Payment Timing" does not appear anywhere in the committed inspector agreement');
ok(!freshBuild.includes('4.2 Payment Timing'), 'D-333: "4.2 Payment Timing" does not appear in the freshly built inspector output');
const stmtMatch = sourceText.match(/<h3>4\.3 Home Inspector Partners<\/h3>\s*(<p>[\s\S]*?<\/p>)/);
ok(!!stmtMatch, 'sanity: the source partner-agreement.html carries the 4.3 Home Inspector Partners statement');
const expectedSection4 = '<section>\n                <h2>4. No Referral Fee or Recruit Bonus</h2>\n                ' +
  (stmtMatch ? stmtMatch[1] : '') + '\n            </section>';
ok(committed.includes(expectedSection4),
  'D-333: Section 4 is exactly the "4. No Referral Fee or Recruit Bonus" heading plus the verbatim 4.3 Home Inspector Partners statement');
ok(committed.split('4. No Referral Fee or Recruit Bonus').length === 2, 'D-333: the new Section 4 heading appears exactly once');
ok(!sourceText.includes('4. No Referral Fee or Recruit Bonus'), 'guard: the source partner-agreement.html is NOT retitled (fee-earning partners keep their Section 4)');
ok(sourceText.includes('4. Referral Fee Structure') && sourceText.includes('4.2 Payment Timing'), 'guard: the source partner-agreement.html still carries its own Section 4 heading and 4.2');

// This exact phrase only EXISTS after the Section 14(a) span removal joins
// "...this Agreement" directly to "; (b) any violation..." -- it is not a
// substring of the (unmodified) source, so it is checked on its own,
// without the source sanity-check the loop above applies to every other
// marker.
ok(renderedOnly.includes('Partner&rsquo;s breach of this Agreement; (b) any violation'),
  'kept: Section 14(a)/(b) reads cleanly with the cross-reference span removed');

// ── 5. gh-2155 HI-0e (D-333, Ben ruling 5882085491): fee-payment mechanics ──
// The inspector build removes Section 5 and Section 10 and every commission
// sentence whose ONLY job is paying / reversing / calculating a commission or
// bonus. A sentence that mixes payment with another obligation is KEPT
// verbatim (Ben's rule) and pinned here, by exact string, so that any
// further "commission" wording (or a silent change to these) fails the test.
// After Ben's ruling 5882387113 (HI-0f) this is exactly the ruled-KEEP list containing
// "commission": items 1 (S8 inducement), 4 (S13 earnings), 5 (S13 liability cap), 6 (S17).
// Items 7 (S14(c)) and 8 (S6) contain no "commission" and are asserted separately below.
const KEPT_AMBIGUOUS = [
  // Section 8 (prohibited inducement to homeowners; not a payout)
  'a specific commission split, fee waiver, discount, or other financial benefit as an inducement to use the Platform',
  // Section 13: earnings disclaimer + liability cap measured in commissions
  'A COMPLETED JOB, A COMMISSION, OR ANY PARTICULAR LEVEL OF EARNINGS',
  // gh-2354 (D-341): the inspector cap is now the greater-of form (pinned in section 6 below).
  'SHALL NOT EXCEED THE GREATER OF TOTAL COMMISSIONS PAID TO PARTNER IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR $100',
  // Section 17: notice of a change to "the commission structure in Section 4"
  'including any change to the commission structure in Section 4',
];
function stripKept(t) { for (const k of KEPT_AMBIGUOUS) t = t.split(k).join(' '); return t; }
function checkNoFeeMechanics(label, html) {
  const rendered = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  ok(!/venmo/i.test(rendered), `${label}: no "Venmo" in the inspector agreement`);
  ok(!/paypal/i.test(rendered), `${label}: no "PayPal" in the inspector agreement`);
  ok(!/Commission Reversal/i.test(rendered), `${label}: no "Commission Reversal" in the inspector agreement`);
  ok(!html.includes('5. Payment Method'), `${label}: Section 5 heading is gone`);
  ok(!html.includes('10. Commission Reversal'), `${label}: Section 10 heading is gone`);
  ok(!rendered.includes('Referral fees and bonuses under Section 4 are paid'), `${label}: the Section 5 payout paragraph is gone`);
  ok(!rendered.includes('Commissions and bonuses are earned only on jobs'), `${label}: the Section 9 commission-earning sentence is gone`);
  ok(!rendered.includes('commission terms'), `${label}: "commission terms" is gone (meta, og and top-of-page notice)`);
  // "commission" (any case) may survive only inside the exact kept-ambiguous sentences.
  const leftover = stripKept(rendered).match(/.{0,50}commission.{0,50}/gi) || [];
  ok(leftover.length === 0, `${label}: "commission" appears only inside the pinned KEPT_AMBIGUOUS sentences` + (leftover.length ? ' -- offenders: ' + JSON.stringify(leftover) : ''));
  // HI-0f (Ben ruling 5882387113, items 2 and 3): the two trimmed fragments are gone,
  // and the trimmed sentences read exactly as the ruling specifies.
  ok(!rendered.includes('forfeiture of any commission attributable to the violating conduct'), `${label}: Section 8 forfeiture clause is trimmed`);
  ok(!rendered.includes('and forfeiture of'), `${label}: no "and forfeiture of" remains`);
  ok(rendered.includes('grounds for immediate termination under Section 11.</p>'), `${label}: Section 8 sentence ends at "termination under Section 11."`);
  ok(!rendered.includes('Termination does not affect commissions'), `${label}: Section 11 payout-survival clause is trimmed`);
  ok(!rendered.includes('fully earned and approved for payout'), `${label}: no "fully earned and approved for payout" remains`);
  ok(rendered.includes('Termination does not relieve Partner of obligations under Sections 6 (Tax Treatment), 8 (Prohibited Conduct, as to conduct before termination), 14 (Indemnification), 15 (Disputes: Individual Arbitration; No Class Actions), or any other provision that by its nature should survive termination.'), `${label}: Section 11 survival sentence keeps Sections 6, 8, 14, 15 verbatim`);
  // Ruled-KEEP items with no "commission" word: S14(c) indemnity trigger and S6 tax treatment.
  ok(rendered.includes("that Partner&rsquo;s acceptance of compensation under this Agreement violated Partner&rsquo;s own legal, professional, or contractual obligations"), `${label}: KEEP item 7 (S14(c)) present`);
  ok(/<h2>6\. Tax Treatment/.test(rendered), `${label}: KEEP item 8 (S6 Tax Treatment) present`);
  const keptPresent = KEPT_AMBIGUOUS.filter(k => rendered.includes(k)).length;
  ok(keptPresent === KEPT_AMBIGUOUS.length, `${label}: all ${KEPT_AMBIGUOUS.length} pinned KEPT_AMBIGUOUS sentences are still present verbatim (${keptPresent})`);
}
checkNoFeeMechanics('HI-0e committed', committed);
checkNoFeeMechanics('HI-0e fresh build', freshBuild);

// No renumbering: every other section keeps its number; 5, 7 and 10 are simply absent.
for (const n of [1, 2, 3, 4, 6, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
  ok(new RegExp('<h2>' + n + '\. ').test(committed), `HI-0e: Section ${n} heading still present under its original number`);
}
ok(!/<h2>5\. /.test(committed) && !/<h2>10\. /.test(committed) && !/<h2>7\. /.test(committed), 'HI-0e: sections 5, 7 and 10 are absent and nothing was renumbered into their slots');
// Kept non-payment obligations survive.
for (const keep of ['Partner is solely responsible for all federal, state, and local taxes', 'Otter Quotes&rsquo; tracking and attribution records are the sole basis', 'Partner is responsible for confirming that homeowners and recruited agents use Partner&rsquo;s correct, current link', 'Either party may terminate this Agreement']) {
  ok(committed.includes(keep), `HI-0e: kept non-payment obligation is present: "${keep.slice(0, 60)}..."`);
}
// The SOURCE (fee-earning partners' agreement) still has every removed item.
for (const need of ['Venmo', 'PayPal', 'Commission Reversal', '5. Payment Method', '10. Commission Reversal', 'Commissions and bonuses are earned only on jobs', 'commission terms', 'Referral fees and bonuses under Section 4 are paid']) {
  ok(sourceText.includes(need), `guard: the source partner-agreement.html still contains "${need}"`);
}
// REMOVAL ONLY: every word of the inspector build already exists in the source
// (multiset check), apart from the words of the new Section 4 heading.
const tok = t => (t.toLowerCase().match(/[a-z0-9$]+/g) || []);
const srcCount = new Map();
for (const w of tok(sourceText)) srcCount.set(w, (srcCount.get(w) || 0) + 1);
// gh-2354 (D-341): the only other words the build adds are the Section 13 cap floor.
for (const w of tok('4. No Referral Fee or Recruit Bonus ' + D341_CAP_NEW)) srcCount.set(w, (srcCount.get(w) || 0) + 1);
const added = [];
for (const w of tok(committed)) { const c = srcCount.get(w) || 0; if (c <= 0) added.push(w); else srcCount.set(w, c - 1); }
ok(added.length === 0, 'HI-0e: the inspector build adds no words that are not in the source (removal only)' + (added.length ? ' -- added: ' + added.slice(0, 10).join(',') : ''));

// ── 6. gh-2354 (D-341): Section 13 liability cap floor, inspector build only ──
// Source: Dustin's ruling "Greater of fees or $100 (Recommended)" (#2155 comment
// 5882472895), registered as D-341; build wording per the #2354 body.
function checkD341Cap(label, html) {
  ok(html.includes(D341_CAP_NEW), `${label}: D-341 inspector Section 13 cap sentence is present verbatim`);
  ok(html.split(D341_CAP_NEW).length === 2, `${label}: the D-341 cap sentence appears exactly once`);
  ok(!html.includes(D341_CAP_OLD), `${label}: the old commission-only cap is gone`);
  ok(!/SHALL NOT EXCEED THE TOTAL COMMISSIONS PAID/.test(html), `${label}: no "SHALL NOT EXCEED THE TOTAL COMMISSIONS PAID" remains`);
}
checkD341Cap('D-341 committed', committed);
checkD341Cap('D-341 fresh build', freshBuild);
// The source (fee-earning partners) keeps the ORIGINAL cap and does not gain the floor.
ok(sourceText.includes(D341_CAP_OLD), 'D-341 guard: the source partner-agreement.html Section 13 still has the original commission-only cap');
ok(!sourceText.includes('GREATER OF') && !sourceText.includes('$100'), 'D-341 guard: the source partner-agreement.html has no greater-of / $100 wording');
// partner-agreement.html is pinned byte-for-byte (sha256 as of origin/main d0b157dc).
const SOURCE_SHA256 = '96949433650e2f9bd1154427bf65d288da8916cf97f78f0d02454dca55d1e101';
ok(crypto.createHash('sha256').update(fs.readFileSync(SOURCE_PATH)).digest('hex') === SOURCE_SHA256, 'D-341 guard: partner-agreement.html is byte-identical to its pinned sha256 (unchanged by gh-2354)');
const s13 = sourceText.match(/<h2>13\.[\s\S]*?<\/section>/);
ok(!!s13 && s13[0].includes(D341_CAP_OLD), 'D-341 guard: the source Section 13 block contains the original cap sentence');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
