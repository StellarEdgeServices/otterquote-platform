/**
 * gh-2155 HI-0b (D-333, Ben close-review comment 5824245098): home
 * inspectors receive no referral fee (Section 4.3), so the agreement
 * version bumps to v3-2026-09 and, for the home_inspector track only:
 *   - the $200/$50 fee table and "home inspectors" in the Section 7
 *     lawful-to-accept-fees list must not be shown;
 *   - the D-266 "Check your employment agreement..." sentence must not be
 *     shown, on either partner-inspectors.html or partner-agreement.html;
 *   - realtor/insurance/adjuster/other visible text and DOM must be
 *     unaffected apart from the version/date label.
 *
 * Written FIRST (repo rule #2121 rule 2) and run against origin/main before
 * the HI-0b fix landed -- see the PR body for the fail-first raw output.
 * This file has no hand-retyped copies of production markup: the
 * home_inspector-track hiding script is extracted VERBATIM out of
 * partner-agreement.html by anchor text and executed in a `vm` context
 * behind a minimal getElementById/URLSearchParams-shaped stand-in, same
 * technique as tests/gh2096-abandon-beacon-restore.mjs and
 * tests/gh2154-p2-app-activation.mjs.
 *
 * Run: node tests/gh2155-hi0b-inspector-agreement.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const D266_SENTENCE = 'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';
const NO_FEE_SENTENCE = 'Home-inspector partners do not receive a referral fee or recruit bonus.';

// This repo's own workflows call both `python3` (most) and bare `python`
// (permissions-ratchet.yml, credential-sweep.yml) depending on the runner;
// tools/partner_parity_check.py has no CI wiring of its own today (a
// pre-existing gap this file's test (d) exercises directly instead --
// flagged in the gh-2155 PR body, not fixed here, out of HI-0b's scope).
function resolvePython() {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch (e) { /* try next candidate */ }
  }
  throw new Error('neither python3 nor python is on PATH');
}
const PY = resolvePython();

function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found for ' + label + ': ' + JSON.stringify(startAnchor));
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found for ' + label + ': ' + JSON.stringify(endAnchor));
  return src.slice(startIdx, endIdx);
}

// Strips HTML comments (this migration's own build-notes carry the strings
// "$200/$50" and "home inspectors" describing WHAT was removed and WHY --
// rendered text is what matters for every check below, not source comments).
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

// ── (a) partner-inspectors.html: no D-266 sentence, no $ fee copy, keeps
//        the plain no-fee sentence, and links to the agreement with
//        ?track=home_inspector. ─────────────────────────────────────────
{
  const rawSrc = fs.readFileSync(path.join(repoRoot, 'partner-inspectors.html'), 'utf8');
  const src = stripComments(rawSrc);
  ok(src.indexOf(D266_SENTENCE) === -1, 'partner-inspectors.html: no D-266 lawful-to-accept-fees sentence');
  ok(src.indexOf(NO_FEE_SENTENCE) !== -1, 'partner-inspectors.html: keeps the plain D-333 no-fee sentence');
  ok(!/\$200\b/.test(src) && !/\$50\b/.test(src), 'partner-inspectors.html: no $200/$50 fee amounts anywhere (rendered content)');
  // Every "referral fee" mention on this page is a NEGATIVE statement ("no
  // referral fee", "No Referral Fee" badge) -- that is D-333 working as
  // intended, not a commission offer. What must never appear is a dollar
  // sign paired with fee/commission/bonus language, or the word
  // "commission" at all (this page never uses it).
  ok(!/\bcommission\b/i.test(src), 'partner-inspectors.html: word "commission" never appears');
  ok(!/\$\s?\d[\d,]*\s*(?:referral|fee|commission|bonus)/i.test(src) && !/(?:referral|fee|commission|bonus)[^.]{0,20}\$\s?\d/i.test(src),
    'partner-inspectors.html: no dollar amount paired with fee/commission/bonus language');
  // Negative phrasing takes two forms on this page: "no referral fee" and
  // "do/does not receive a referral fee" -- both are D-333 working as
  // intended. Require one of those two negations within the 30 characters
  // immediately before each "referral fee" match.
  const feeRe = /referral\s+fee/gi;
  let feeMatch;
  let totalFeeMentions = 0;
  let negativeFeeMentions = 0;
  while ((feeMatch = feeRe.exec(src)) !== null) {
    totalFeeMentions++;
    const before = src.slice(Math.max(0, feeMatch.index - 30), feeMatch.index);
    if (/\bno\s+$/i.test(before) || /\bnot\s+receive\s+a\s+$/i.test(before)) {
      negativeFeeMentions++;
    }
  }
  ok(totalFeeMentions > 0 && negativeFeeMentions === totalFeeMentions,
    'partner-inspectors.html: every "referral fee" mention is a negative statement ("no referral fee" / "do not receive a referral fee")');
  ok(rawSrc.indexOf('href="partner-agreement.html?track=home_inspector"') !== -1,
    'partner-inspectors.html: agreement link carries ?track=home_inspector');
}

// ── Load partner-agreement.html and the extracted hiding script once. ───
const agreementSrc = fs.readFileSync(path.join(repoRoot, 'partner-agreement.html'), 'utf8');

function makeFakeDom(hrefSearch) {
  const hidden = new Set();
  const elements = {
    feeStructureBlock: { style: {} },
    d266DisclaimerBox: { style: {} },
  };
  const fakeWindow = {
    location: { search: hrefSearch },
    document: {
      getElementById: (id) => elements[id] || null,
    },
    URLSearchParams,
  };
  fakeWindow.window = fakeWindow;
  fakeWindow.document = fakeWindow.document;
  return { fakeWindow, elements };
}

function runHidingScript(hrefSearch) {
  const scriptSrc = extractBetween(
    agreementSrc,
    '<script>\n    (function () {',
    '\n    </script>',
    'partner-agreement.html home_inspector track-detection script'
  );
  const { fakeWindow, elements } = makeFakeDom(hrefSearch);
  const context = vm.createContext(fakeWindow);
  vm.runInContext('(function () {' + scriptSrc.split('(function () {').slice(1).join('(function () {'), context);
  return elements;
}

// ── (b) home_inspector track: fee table + D-266 box hidden, and the
//        version literal is present on the page (v3-2026-09). ──────────
{
  ok(agreementSrc.indexOf('v3-2026-09') !== -1, 'partner-agreement.html: shows v3-2026-09 on the page');
  ok(!/home inspectors/i.test(
      stripComments(extractBetween(agreementSrc, '<h2>7. Licensing', '</section>', 'Section 7 body'))
    ),
    'partner-agreement.html: "home inspectors" removed from the Section 7 lawful-to-accept-fees list (rendered content)');
  ok(agreementSrc.indexOf('id="feeStructureBlock"') !== -1 && agreementSrc.indexOf('id="d266DisclaimerBox"') !== -1,
    'partner-agreement.html: fee table and D-266 box are individually addressable for track-based hiding');

  for (const paramName of ['track', 'agent_type']) {
    const els = runHidingScript('?' + paramName + '=home_inspector');
    ok(els.feeStructureBlock.style.display === 'none', 'home_inspector (?' + paramName + '=): fee table hidden');
    ok(els.d266DisclaimerBox.style.display === 'none', 'home_inspector (?' + paramName + '=): D-266 box hidden');
  }
}

// ── (c) realtor/insurance (no track param, or a non-inspector value):
//        nothing hidden, and the page's visible text is unchanged apart
//        from the version/effective-date label, vs. origin/main. ───────
{
  for (const search of ['', '?track=re_agent', '?agent_type=insurance_agent']) {
    const els = runHidingScript(search);
    ok(els.feeStructureBlock.style.display !== 'none', 'non-inspector (' + JSON.stringify(search) + '): fee table NOT hidden');
    ok(els.d266DisclaimerBox.style.display !== 'none', 'non-inspector (' + JSON.stringify(search) + '): D-266 box NOT hidden');
  }

  let mainSrc = null;
  try {
    mainSrc = execFileSync('git', ['show', 'origin/main:partner-agreement.html'], { cwd: repoRoot, encoding: 'utf8' });
  } catch (e) {
    console.log('SKIP: byte-identical-vs-origin/main check (git show failed: ' + e.message + ')');
  }
  if (mainSrc !== null) {
    // Strip the two lines this change is allowed to touch (Effective Date,
    // Version) plus the new HTML-comment/id/script additions, then compare
    // the remaining legal *text* (tags stripped, whitespace normalized) --
    // a byte diff would also flag the id="..." attributes and the trailing
    // script, which carry no visible words for realtor/insurance.
    function visibleText(html) {
      return html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&rsquo;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '’')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const mainText = visibleText(mainSrc)
      .replace('Effective Date: August 20, 2026', '')
      .replace(/home inspectors,\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const newText = visibleText(agreementSrc)
      .replace('Effective Date: September 25, 2026', '')
      .replace('Version: v3-2026-09', '')
      .replace(/\s+/g, ' ')
      .trim();
    ok(mainText === newText,
      'partner-agreement.html: visible text for realtor/insurance is unchanged vs origin/main apart from the version/date label and the Section 7 "home inspectors," removal');
  }
}

// ── (d) CI legal-surface check (tools/partner_parity_check.py): still
//        FAILS if the D-266 sentence is removed from partner-re.html
//        (negative control -- realtor is NOT exempt), and PASSES today
//        with the inspector-only exemption in place. ────────────────────
{
  let passResult = null;
  try {
    execFileSync(PY, [path.join(repoRoot, 'tools', 'partner_parity_check.py')], { cwd: repoRoot, encoding: 'utf8' });
    passResult = 0;
  } catch (e) {
    passResult = (e.status === undefined ? -1 : e.status);
    console.log('  [partner_parity_check.py PASS-run output]\n' + (e.stdout || ''));
  }
  ok(passResult === 0, 'partner_parity_check.py: passes today with the inspector-only D-266 exemption');

  const tmpDir = fs.mkdtempSync(path.join(repoRoot, 'tests', '.gh2155-hi0b-tmp-'));
  try {
    for (const f of fs.readdirSync(repoRoot)) {
      if (f.endsWith('.html') || f === 'js' || f === 'react-app' || f === 'tools') {
        fs.cpSync(path.join(repoRoot, f), path.join(tmpDir, f), { recursive: true });
      }
    }
    const rePath = path.join(tmpDir, 'partner-re.html');
    const reSrc = fs.readFileSync(rePath, 'utf8');
    ok(reSrc.indexOf(D266_SENTENCE) !== -1, 'sanity: partner-re.html carries the D-266 sentence before the negative control mutates it');
    fs.writeFileSync(rePath, reSrc.replace(D266_SENTENCE, 'REMOVED FOR NEGATIVE CONTROL'));

    let negResult = null;
    let negOutput = '';
    try {
      execFileSync(PY, [path.join(tmpDir, 'tools', 'partner_parity_check.py')], { cwd: tmpDir, encoding: 'utf8' });
      negResult = 0;
    } catch (e) {
      negResult = (e.status === undefined ? -1 : e.status);
      negOutput = (e.stdout || '');
    }
    ok(negResult === 1, 'partner_parity_check.py: FAILS when the D-266 sentence is removed from partner-re.html (realtor is NOT exempt)');
    ok(negOutput.indexOf('partner-re.html') !== -1 && negOutput.indexOf('d266_disclaimer') !== -1,
      'partner_parity_check.py: failure output names partner-re.html and the d266_disclaimer check');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── (e) migration file's version literal. ────────────────────────────────
{
  const migDir = path.join(repoRoot, 'supabase', 'migrations');
  const migFile = fs.readdirSync(migDir).find((f) => f.endsWith('_gh2155_hi0b_agreement_v3.sql'));
  ok(!!migFile, 'supabase/migrations: gh2155_hi0b_agreement_v3 migration file exists');
  if (migFile) {
    const migSrc = fs.readFileSync(path.join(migDir, migFile), 'utf8');
    ok(migSrc.indexOf("v_agreement_version CONSTANT text := 'v3-2026-09';") !== -1,
      'migration: v_agreement_version literal is v3-2026-09');
    ok((migSrc.match(/CREATE OR REPLACE FUNCTION public\.register_partner/g) || []).length === 1,
      'migration: exactly one CREATE OR REPLACE FUNCTION public.register_partner');
  }

  const rbDir = path.join(repoRoot, 'supabase', 'migrations_rollbacks');
  const rbFile = migFile && fs.readdirSync(rbDir).find((f) => f === migFile.replace('.sql', '_rollback.sql'));
  ok(!!rbFile, 'supabase/migrations_rollbacks: matching rollback file exists (same timestamp)');
  if (rbFile) {
    const rbSrc = fs.readFileSync(path.join(rbDir, rbFile), 'utf8');
    ok(rbSrc.indexOf("v_agreement_version CONSTANT text := 'v2-2026-08';") !== -1,
      'rollback: v_agreement_version literal restores v2-2026-08');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
