/**
 * gh-2155 HI-0b (D-333, Ben close-review comment 5824245098, round 2 ruling
 * comment 5825652208): home inspectors receive no referral fee or recruit
 * bonus (Section 4.3), so the agreement version bumps to v3-2026-09 and, for
 * the home_inspector track only:
 *   - the $200/$50 fee table, Section 4.1 (Recruit Bonus accrual rules), the
 *     D-266 "Check your employment agreement..." sentence, and the Section 7
 *     "represents and warrants ... lawful" paragraph must not be shown;
 *   - "home inspectors" must not appear in the Section 7 lawful-to-accept-fees
 *     list (all tracks);
 *   - the hide must FAIL CLOSED: an inspector following the real signup link
 *     (partner-agreement.html?track=home_inspector#track-home-inspector)
 *     must not see the hidden content even with JavaScript disabled, via a
 *     CSS ":target" rule keyed to an anchor span that is the first child of
 *     .legal-content. The ?agent_type=home_inspector JS path is kept as a
 *     second, belt-and-braces mechanism;
 *   - realtor/insurance/adjuster/other visible text and DOM must be
 *     unaffected apart from the version/date label and the "home inspectors"
 *     removal.
 *
 * Written FIRST (repo rule #2121 rule 2) and run against head 17a22b13
 * (round 1's head, pre-round-2) before this round's fix landed -- see the PR
 * body for the fail-first raw output. This file has no hand-retyped copies
 * of production markup: the home_inspector-track hiding script is extracted
 * VERBATIM out of partner-agreement.html by anchor text and executed in a
 * `vm` context behind a minimal document/URLSearchParams-shaped stand-in,
 * same technique as tests/gh2096-abandon-beacon-restore.mjs and
 * tests/gh2154-p2-app-activation.mjs. Round 2's fail-closed (no-JS) proof is
 * a structural/CSS assertion over the raw markup -- this repo has no
 * Playwright or jsdom dependency at its root (only react-app/ has its own
 * package.json), so there is no real browser or DOM available to render the
 * page with JavaScript disabled; the structural proof instead verifies the
 * exact properties that make the CSS ":target ~ *" sibling-selector
 * mechanism work: the anchor span's position as .legal-content's first
 * child, and that every hidden block is nested inside a later sibling
 * <section>.
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
  ok(rawSrc.indexOf('href="partner-agreement.html?track=home_inspector#track-home-inspector"') !== -1,
    'partner-inspectors.html: agreement link carries ?track=home_inspector AND the #track-home-inspector fail-closed anchor');
}

// ── Load partner-agreement.html and the extracted hiding script once. ───
const agreementSrc = fs.readFileSync(path.join(repoRoot, 'partner-agreement.html'), 'utf8');

// The round-2 script hides by class (`.inspector-hide`), not by id -- four
// elements carry that class: the fee table block, the Section 4.1 wrapper,
// the D-266 box, and the Section 7 warranty paragraph. The fake DOM's
// querySelectorAll('.inspector-hide') returns all four so the extracted
// script's real `for` loop (not a hand-rewritten equivalent) exercises the
// exact same iteration production runs.
const INSPECTOR_HIDE_KEYS = ['feeStructureBlock', 'recruitBonusSection', 'd266DisclaimerBox', 'warrantsParagraph'];

function makeFakeDom(hrefSearch) {
  const elements = {};
  for (const key of INSPECTOR_HIDE_KEYS) { elements[key] = { style: {} }; }
  const fakeWindow = {
    location: { search: hrefSearch },
    document: {
      querySelectorAll: (selector) => (selector === '.inspector-hide' ? INSPECTOR_HIDE_KEYS.map((k) => elements[k]) : []),
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

// ── (b) home_inspector track, JS-enabled belt-and-braces path: fee table,
//        Section 4.1, D-266 box, and the Section 7 warranty paragraph are
//        all hidden via .inspector-hide, and the version literal is present
//        on the page (v3-2026-09). Section 4.3 (the inspector clause) is
//        NEVER hidden -- it stays visible on every track. ─────────────────
{
  ok(agreementSrc.indexOf('v3-2026-09') !== -1, 'partner-agreement.html: shows v3-2026-09 on the page');
  ok(!/home inspectors/i.test(
      stripComments(extractBetween(agreementSrc, '<h2>7. Licensing', '</section>', 'Section 7 body'))
    ),
    'partner-agreement.html: "home inspectors" removed from the Section 7 lawful-to-accept-fees list (rendered content)');
  ok(agreementSrc.indexOf('id="feeStructureBlock"') !== -1 && agreementSrc.indexOf('id="d266DisclaimerBox"') !== -1,
    'partner-agreement.html: fee table and D-266 box are individually addressable for track-based hiding');
  ok((stripComments(agreementSrc).match(/class="[^"]*\binspector-hide\b[^"]*"/g) || []).length === 4,
    'partner-agreement.html: exactly 4 elements carry the inspector-hide class (fee block, Section 4.1, D-266 box, Section 7 warranty paragraph)');
  ok(!/class="[^"]*\binspector-hide\b/.test(
      stripComments(extractBetween(agreementSrc, '<h3>4.3 Home Inspector Partners</h3>', '</section>', 'Section 4.3'))
    ),
    'partner-agreement.html: Section 4.3 (the inspector no-fee clause) is never inspector-hide -- stays visible to inspectors');

  for (const paramName of ['track', 'agent_type']) {
    const els = runHidingScript('?' + paramName + '=home_inspector');
    for (const key of INSPECTOR_HIDE_KEYS) {
      ok(els[key].style.display === 'none', 'home_inspector (?' + paramName + '=): ' + key + ' hidden (JS belt-and-braces path)');
    }
  }
}

// ── (b2) FAIL-CLOSED structural proof (no real browser/jsdom/Playwright at
//        this repo's root -- see file header). Verifies the exact structural
//        properties the CSS "#track-home-inspector:target ~ * .inspector-hide"
//        rule depends on, so the hide works with JavaScript disabled: the
//        anchor span is .legal-content's FIRST child (so it precedes every
//        section as an earlier sibling, which ~ requires), the CSS rule
//        text matches verbatim, and every .inspector-hide element sits
//        inside a <section> that is itself a later sibling of the span
//        (this file's sections never nest, verified separately below). ────
{
  // extractBetween's slice INCLUDES the start anchor itself, which would
  // wrongly count '<div class="legal-content">' as "content before the
  // span" -- strip it back off so legalContent is the wrapper's actual
  // children only.
  const legalContentWithTag = extractBetween(agreementSrc, '<div class="legal-content">', '</div><!-- /.legal-content -->', 'legal-content wrapper');
  const legalContent = legalContentWithTag.slice('<div class="legal-content">'.length);
  const spanIdx = legalContent.indexOf('<span id="track-home-inspector"></span>');
  ok(spanIdx !== -1, 'partner-agreement.html: #track-home-inspector anchor span exists inside .legal-content');

  // "First child" allowing only whitespace before it -- HTML comments ARE
  // real nodes (though not elements), so a comment before the span would
  // still make it the first *element* child, which is all the sibling
  // selector needs; only non-whitespace, non-comment text/markup before it
  // would break the "first child" property this CSS rule relies on.
  const beforeSpan = stripComments(legalContent.slice(0, spanIdx));
  ok(spanIdx !== -1 && beforeSpan.trim() === '',
    'partner-agreement.html: #track-home-inspector span is the FIRST (element) child of .legal-content -- required for the ~ sibling selector to reach every later section');

  const cssRule = stripComments(agreementSrc).replace(/\s+/g, ' ');
  ok(cssRule.indexOf('#track-home-inspector:target ~ * .inspector-hide, #track-home-inspector:target ~ .inspector-hide { display: none; }') !== -1,
    'partner-agreement.html: the CSS :target fail-closed rule is present verbatim (whitespace-normalized)');

  // Every top-level <section ...>...</section> block within .legal-content
  // (round 3: Section 7's own <section> tag now carries the inspector-hide
  // class directly -- "<section class=...>", not bare "<section>" -- so
  // every section-tag regex below must allow an opening-tag attribute list.
  // This file's sections do not nest -- verified by an equal open/close
  // count).
  const SECTION_OPEN_RE = /<section\b[^>]*>/g;
  const SECTION_BLOCK_RE = /<section\b[^>]*>[\s\S]*?<\/section>/g;
  const openCount = (legalContent.match(SECTION_OPEN_RE) || []).length;
  const closeCount = (legalContent.match(/<\/section>/g) || []).length;
  ok(openCount === closeCount && openCount > 0, 'sanity: <section> tags are not nested in partner-agreement.html (equal open/close count, both > 0)');
  const sectionBlocks = legalContent.match(SECTION_BLOCK_RE) || [];

  ok((stripComments(legalContent).match(/class="[^"]*\binspector-hide\b[^"]*"/g) || []).length === 4,
    'sanity: 4 inspector-hide elements found inside .legal-content (fee block, Section 4.1, Section 7 itself, Section 14(a) span)');

  // Each .inspector-hide element must be reachable by ONE of the CSS rule's
  // two selector branches: "~ * .inspector-hide" (a DESCENDANT of a later
  // sibling section -- the fee block, the 4.1 wrapper, and the Section 14(a)
  // span all qualify) or "~ .inspector-hide" (the class is directly ON a
  // later sibling itself -- Section 7's own <section class="inspector-hide">
  // qualifies here). Both require the containing/matching section to START
  // after the anchor span.
  let allCovered = true;
  let allSectionsAfterSpan = true;
  for (const block of sectionBlocks) {
    const blockStart = legalContent.indexOf(block);
    const ownOpenTag = block.match(SECTION_OPEN_RE)[0];
    const hasOwnClass = /class="[^"]*\binspector-hide\b/.test(ownOpenTag);
    const hasDescendantClass = /class="[^"]*\binspector-hide\b/.test(stripComments(block.slice(ownOpenTag.length)));
    if ((hasOwnClass || hasDescendantClass) && blockStart <= spanIdx) { allSectionsAfterSpan = false; }
  }
  // Nothing carrying the class should exist OUTSIDE every section block
  // entirely (that would be reachable by neither selector branch).
  const outsideAnySection = stripComments(legalContent).replace(SECTION_BLOCK_RE, '');
  if (/class="[^"]*\binspector-hide\b/.test(outsideAnySection)) { allCovered = false; }
  ok(allCovered, 'partner-agreement.html: every .inspector-hide element (or the section carrying the class itself) is inside/is a <section> -- required for one of the two CSS selector branches to reach it');
  ok(allSectionsAfterSpan, 'partner-agreement.html: every <section> containing (or carrying) an .inspector-hide comes AFTER the anchor span in document order (required for the ~ general-sibling combinator)');
}

// ── (c) realtor/insurance (no track param, or a non-inspector value):
//        nothing hidden, and the page's visible text is unchanged apart
//        from the version/effective-date label, vs. origin/main. ───────
{
  for (const search of ['', '?track=re_agent', '?agent_type=insurance_agent']) {
    const els = runHidingScript(search);
    for (const key of INSPECTOR_HIDE_KEYS) {
      ok(els[key].style.display !== 'none', 'non-inspector (' + JSON.stringify(search) + '): ' + key + ' NOT hidden');
    }
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
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&rsquo;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '’')
        .replace(/\s+/g, ' ')
        // Round 3 wraps an inline <span> around a mid-sentence phrase (no
        // surrounding whitespace in the source) purely so it is addressable
        // for hiding -- real browsers render an inline tag boundary with no
        // extra space, but this crude regex tag-stripper replaces every tag
        // with a literal space to avoid accidentally concatenating adjacent
        // BLOCK-level content. That is correct for block boundaries and a
        // false diff for this one inline one; collapse " ," / " ;" etc. back
        // together the same way on both sides of the comparison below.
        .replace(/\s+([,;.:!?])/g, '$1')
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

// ── (b3) round 3 (Ben rulings 5825652208 item 2 / 5825785741 item 1, per
//        REVIEW FAIL 5825693018 must-fix 1): the inspector-track rendered
//        text must have NONE of "Partner earns a Recruit Bonus" (Section
//        4.1), "represents and warrants" (Section 7), or "representation in
//        Section 7" (the Section 14(a) cross-reference) -- and re_agent /
//        insurance_agent / no-param renders must still have all three
//        (negative control: hiding is per-track, not a text deletion). No
//        real DOM is available (see file header), so "the inspector-track
//        rendered text" is simulated by literally removing each known
//        .inspector-hide block's markup from the source (not just setting
//        display:none, which a string-based text check can't observe) and
//        re-running the same visibleText() extraction used in (c). ────────
{
  function stripInspectorHideElements(html) {
    return html
      .replace(/<section\b[^>]*\bclass="[^"]*\binspector-hide\b[^"]*"[^>]*>[\s\S]*?<\/section>/g, ' ')
      .replace(/<div\b[^>]*\bclass="[^"]*\binspector-hide\b[^"]*"[^>]*>[\s\S]*?<\/div>/g, ' ')
      .replace(/<p\b[^>]*\bclass="[^"]*\binspector-hide\b[^"]*"[^>]*>[\s\S]*?<\/p>/g, ' ')
      .replace(/<span\b[^>]*\bclass="[^"]*\binspector-hide\b[^"]*"[^>]*>[\s\S]*?<\/span>/g, ' ');
  }
  function toText(html) {
    return html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&rsquo;/g, '’')
      .replace(/\s+/g, ' ')
      // Same inline-tag-boundary artifact as visibleText() above (an
      // adjacent <span>/removed-block boundary with no real source
      // whitespace becomes a spurious space before punctuation).
      .replace(/\s+([,;.:!?])/g, '$1')
      .trim();
  }

  const PHRASES = ['Partner earns a Recruit Bonus', 'represents and warrants', 'representation in Section 7'];

  const removedCount = (stripInspectorHideElements(agreementSrc).match(/class="[^"]*\binspector-hide\b/g) || []).length;
  ok(removedCount === 0, 'sanity: stripInspectorHideElements() removes all 4 inspector-hide blocks (fee table, Section 4.1, Section 7, Section 14(a) span) with no leftovers');

  const inspectorText = toText(stripInspectorHideElements(agreementSrc));
  for (const phrase of PHRASES) {
    ok(inspectorText.indexOf(phrase) === -1, 'inspector-track rendered text: "' + phrase + '" is ABSENT (round 3 hide)');
  }

  // Section 14(a) reads cleanly once its hidden span is gone -- no dangling
  // connector, no leftover comma before the semicolon.
  ok(inspectorText.indexOf("Partner’s breach of this Agreement; (b) any violation") !== -1,
    'inspector-track rendered text: Section 14(a) reads "Partner’s breach of this Agreement; (b) any violation..." with no dangling words');

  // Negative control: the raw (un-stripped) document -- what re_agent,
  // insurance_agent and a no-param visitor actually receive, since the hide
  // is display:none/CSS :target, never a literal text deletion -- still
  // carries all three phrases. This is what (c) already proved is
  // byte-for-byte unchanged from origin/main for those tracks.
  const fullText = toText(agreementSrc);
  for (const phrase of PHRASES) {
    ok(fullText.indexOf(phrase) !== -1, 'negative control: "' + phrase + '" is PRESENT in the raw document (re_agent/insurance_agent/no-param never hide it)');
  }
}

// ── (b4) round 3 must-fix 3 (5825785741 item 2(b) / 5825693018 must-fix 2):
//        js/nav.js's footer "Partner Agreement" link must carry
//        ?track=home_inspector#track-home-inspector when the page is
//        partner-inspectors.html, or when window.currentPartnerAgentType is
//        'home_inspector' (the global partner-dashboard.html already sets
//        for its own inspector-specific copy) -- and must NOT for any other
//        page/track. Extracted verbatim by anchor and run in a `vm` context
//        behind a minimal document/window stand-in, same technique as the
//        rest of this file. ────────────────────────────────────────────────
{
  const navSrc = fs.readFileSync(path.join(repoRoot, 'js', 'nav.js'), 'utf8');
  const snippet = extractBetween(
    navSrc,
    'const isInspectorTrack = window.location.pathname',
    "'/partner-agreement.html';",
    'js/nav.js renderFooter() inspector-track href logic'
  ) + "'/partner-agreement.html';";

  function computeHref(pathname, agentType) {
    const fakeWindow = { location: { pathname }, currentPartnerAgentType: agentType };
    fakeWindow.window = fakeWindow;
    const context = vm.createContext(fakeWindow);
    vm.runInContext(snippet + '\npartnerAgreementHref;', context);
    return vm.runInContext('partnerAgreementHref', context);
  }

  ok(computeHref('/partner-inspectors.html', undefined) === '/partner-agreement.html?track=home_inspector#track-home-inspector',
    'js/nav.js footer link: partner-inspectors.html carries ?track=home_inspector#track-home-inspector');
  ok(computeHref('/partner-dashboard.html', 'home_inspector') === '/partner-agreement.html?track=home_inspector#track-home-inspector',
    'js/nav.js footer link: partner-dashboard.html with window.currentPartnerAgentType=home_inspector carries the tracked link');
  ok(computeHref('/partner-dashboard.html', 're_agent') === '/partner-agreement.html',
    'js/nav.js footer link: partner-dashboard.html with a non-inspector agent_type is untouched');
  ok(computeHref('/partner-re.html', undefined) === '/partner-agreement.html',
    'js/nav.js footer link: an unrelated page with no inspector signal is untouched');
  ok(computeHref('/index.html', undefined) === '/partner-agreement.html',
    'js/nav.js footer link: the homepage (no inspector signal at all) is untouched');
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
