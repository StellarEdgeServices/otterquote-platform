// node --test scripts/r177/predicate.test.mjs   (Node 20+, no deps)
//
// R-177 (2026-09-07): the rule-vocabulary tests for the legal/money predicate,
// carried over from scripts/r120/verify.test.mjs. The signature half of that
// suite — `verifySignedApproval`, `approvalMessage`, the base64url round trip,
// the forged/stale/wrong-PR signature controls and the ECDSA keypair fixtures —
// went with R-120's signing key and is deleted. What survives is what the
// R-177 labeller actually runs: which lines the rules fire on, and which they
// must stay silent on.
//
// Scope (which FILES and which LINES the rules may look at) lives in
// scripts/r177/predicate.scope.test.mjs.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLegalMoneyContent, classifyLine } from './predicate.mjs';


function diff(file, added = [], removed = [], { oldStart = 10, newStart = 10 } = {}) {
  const body = [...removed.map((l) => '-' + l), ...added.map((l) => '+' + l)].join('\n');
  return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -${oldStart},${removed.length + 1} +${newStart},${added.length + 1} @@\n context line\n${body}\n`;
}

describe('detectLegalMoneyContent', () => {
  test('#1621-style cents constant fires', () => {
    const r = detectLegalMoneyContent(diff('js/upgrade.js', ['const UPGRADE_PRICE_UNDER_CENTS = 2500;']));
    assert.equal(r.hit, true);
    assert.deepEqual(r.lines.map(({ file, line, rule, side }) => ({ file, line, rule, side })), [{ file: 'js/upgrade.js', line: 11, rule: 'currency-amount', side: '+' }]);
  });

  test('"you get $200 every time" fires', () => {
    const r = detectLegalMoneyContent(diff('refer-a-friend.html', ['<p>you get $200 every time</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].rule, 'currency-amount');
  });

  test('"not a public adjuster" fires (legal wording)', () => {
    const r = detectLegalMoneyContent(diff('partner-adjusters.html', ['<p>OtterQuote is not a public adjuster.</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].rule, 'legal-consent-word');
  });

  test('REMOVED lines are scanned too (deleting a disclaimer is legal/money content)', () => {
    const r = detectLegalMoneyContent(diff('terms.html', [], ['<p>Binding arbitration applies.</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].side, '-');
    assert.equal(r.lines[0].line, 11);
  });

  test('money words fire: refund / fee / payout', () => {
    for (const l of ['We will refund you.', 'platform fee applies', 'payout arrives Friday', '10 USD each', 'ten dollars? no: 5 dollars']) {
      assert.ok(detectLegalMoneyContent(diff('index.html', [l])).hit, l);
    }
  });

  test('does NOT fire on a ga-gate.js script tag (#1622) or gtag/GTM lines', () => {
    const r = detectLegalMoneyContent(diff('index.html', [
      '<script src="/js/ga-gate.js"></script>',
      "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>",
      "gtag('event', 'purchase', { value: 200 });",
    ]));
    assert.equal(r.hit, false, JSON.stringify(r.lines));
  });

  test('does NOT fire on import / require lines or URL-only lines', () => {
    const r = detectLegalMoneyContent(diff('js/thing.js', [
      "import { price } from './pricing.js';",
      "const { invoice } = require('./invoice');",
      'https://example.com/pricing/terms',
      '',
    ]));
    assert.equal(r.hit, false, JSON.stringify(r.lines));
  });

  test('does NOT scan excluded paths', () => {
    for (const f of ['js/pricing.test.js', 'react-app/src/__tests__/fee.tsx', 'package-lock.json', '.github/workflows/foo.yml', 'scripts/r177/notes.mjs', 'Docs/pricing.md', 'In Flight/plan.md']) {
      assert.equal(detectLegalMoneyContent(diff(f, ['the price is $5 and you consent'])).hit, false, f);
    }
  });

  test('filenames alone never trigger (content-based, not path-based)', () => {
    const r = detectLegalMoneyContent(diff('partner-agreement.html', ['<div class="row"></div>']));
    assert.equal(r.hit, false);
  });

  test('predicate files always trigger, even with innocuous content', () => {
    for (const f of ['scripts/r177/predicate.mjs', '.github/workflows/r177-legal-read.yml']) {
      const r = detectLegalMoneyContent(diff(f, ['x']));
      assert.equal(r.hit, true, f);
      assert.equal(r.lines[0].rule, 'predicate-file');
    }
  });

  test('context lines are not scanned; hunk line numbers track', () => {
    const d = `diff --git a/a.html b/a.html\n--- a/a.html\n+++ b/a.html\n@@ -1,4 +1,5 @@\n <p>price $5</p>\n old\n+new1\n+we guarantee it\n same\n`;
    const r = detectLegalMoneyContent(d);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].line, 4);
    assert.equal(r.lines[0].rule, 'legal-consent-word');
  });

  test('classifyLine is case-insensitive', () => {
    assert.equal(classifyLine('WARRANTY VOID'), 'legal-consent-word');
    assert.equal(classifyLine('Refund Policy'), 'money-word');
    assert.equal(classifyLine('hello world'), null);
  });

  test('empty diff -> no hit', () => {
    assert.deepEqual(detectLegalMoneyContent(''), { hit: false, lines: [], files: [] });
  });
});

// 2026-09-05 (CTO RUN 23): the predicate discriminated on vocabulary, not money.
describe('detectLegalMoneyContent — comments vs money identifiers (2026-09-05)', () => {
  const diff = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${lines.length + 1} @@\n x\n${lines.map((l) => '+' + l).join('\n')}\n`;
  it('does NOT fire on "Agreement" / "guarantee" / "/terms" inside code comments (#1673, #1674)', () => {
    const d = diff('react-app/app/trade-selector/utils.ts', ['  // Agreement, or a ZIP that cannot be resolved, keeps the token', '  /* mathematically guaranteed to */', '  // (e.g. /login, /auth-callback, /terms) — see #1639.']);
    assert.equal(detectLegalMoneyContent(d).hit, false);
  });
  it('DOES fire on money-path identifiers in code (#1670 accept_bid / has_payment_method)', () => {
    const d = diff('supabase/migrations/20260904_accept_bid_guard.sql', ['  IF NEW.has_payment_method IS FALSE THEN', "    RAISE EXCEPTION 'contractor_no_payment_method';"]);
    const r = detectLegalMoneyContent(d); assert.equal(r.hit, true); assert.ok(r.lines.some((l) => l.rule === 'money-identifier'));
  });
  it('still fires on a real currency constant in code, and on prose in HTML', () => {
    assert.equal(detectLegalMoneyContent(diff('x.ts', ['const UPGRADE_PRICE_UNDER_CENTS = 2500;'])).hit, true);
    assert.equal(detectLegalMoneyContent(diff('faq.html', ['<p>Agreement terms apply to every project</p>'])).hit, true);
  });
  it('a "$25" inside a code comment is prose, not a change of price', () => {
    assert.equal(detectLegalMoneyContent(diff('x.ts', ['  // costs $25 under 50 SQ'])).hit, false);
  });
});

// gh-1701 closing criterion 2, verbatim: "a fixture proving the predicate still
// FIRES on real customer money copy in an `.html` file -- specifically the
// `$15 credit` sentence from #1692, which must keep tripping R-120. A fix that
// quiets the false positives by also quieting the true ones is a regression,
// not a fix."
//
// This is the TRUE-POSITIVE half of the gh-1701 narrowing, and it is the half
// no other fixture covers: the suite already proves the predicate goes SILENT on
// a comment in a `.ts` file, and silence is cheap to achieve by accident. What
// nothing asserted until now is that the same narrowing left real homeowner-facing
// money copy in an `.html` TEXT NODE still firing.
//
// The sentence is not invented for the test. It is the copy #1692 was filed to
// cut, quoted from that issue's body:
//   "OtterQuote's measurement partner applies a $15 credit toward this report's
//    cost, so you are not covering its full price."
// It is a price representation to a homeowner about who bears a cost, on a
// production page (`help-measurements.html`), and it is exactly the class R-177
// exists to route to a second reader.
//
// CAN THIS FIXTURE FAIL? Yes, and it was observed failing before it was trusted.
// Ablation, run in a scratch copy of scripts/ and never committed: neuter the
// `currency-amount` rule (`/\$\s?\d/` -> `/^\$NEVER_MATCHES_ABLATION/`). Result,
// `node --test scripts/r177/predicate.test.mjs`: 21 tests, 19 pass, 2 FAIL --
//   not ok  the #1692 "$15 credit" sentence in an .html TEXT NODE still fires
//           error: 'expected currency-amount, got ["money-word"]'
//   not ok  "you get $200 every time" fires        (pre-existing, same cause)
//
// READ THAT FAILURE MESSAGE, because it is the reason this fixture asserts the
// RULE and not just `hit`. Under the ablation `hit` stays TRUE -- the sentence
// contains the word "credit", which `money-word` catches -- so a fixture written
// as `assert.equal(r.hit, true)` would have passed against a predicate with its
// currency rule ripped out, and would have certified a gate that no longer sees
// prices. The specific-rule assertion is what makes this a control rather than a
// green tick.
describe('gh-1701 criterion 2 -- the true positive that must survive the narrowing', () => {
  const CREDIT_SENTENCE =
    "OtterQuote's measurement partner applies a $15 credit toward this report's cost, so you are not covering its full price.";

  it('the #1692 "$15 credit" sentence in an .html TEXT NODE still fires', () => {
    const r = detectLegalMoneyContent(diff('help-measurements.html', [`                    <p>${CREDIT_SENTENCE}</p>`]));
    assert.equal(r.hit, true, 'real homeowner money copy in HTML text must keep tripping the gate');
    assert.ok(r.lines.some((l) => l.rule === 'currency-amount'), `expected currency-amount, got ${JSON.stringify(r.lines.map((l) => l.rule))}`);
    assert.equal(r.lines[0].file, 'help-measurements.html');
    assert.equal(r.lines[0].side, '+');
  });

  it('and it fires on REMOVAL too -- cutting a price representation is a legal/money diff', () => {
    // #1692 was a diff that DELETED this sentence. A gate that only watches
    // additions would let ruled-cut money copy leave (or return) unread.
    const r = detectLegalMoneyContent(diff('help-measurements.html', [], [`                    <p>${CREDIT_SENTENCE}</p>`]));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].side, '-');
  });

  it('the DISCRIMINATING pair: the same sentence in a .js comment is silent, in .html text it is not', () => {
    // If both halves fired, the narrowing did nothing. If both went silent, the
    // narrowing ate the true positive. Only the split is a pass.
    const inCode = detectLegalMoneyContent(diff('js/upgrade.js', [`  // ${CREDIT_SENTENCE}`]));
    const inCopy = detectLegalMoneyContent(diff('help-measurements.html', [`                    <p>${CREDIT_SENTENCE}</p>`]));
    assert.equal(inCode.hit, false, 'a JS comment quoting the sentence is prose, not a price change');
    assert.equal(inCopy.hit, true, 'the same sentence as homeowner-visible copy must fire');
  });

  it('the word rules still fire on real .html legal copy (not only the currency rule)', () => {
    const r = detectLegalMoneyContent(diff('help-measurements.html', ['                    <p>We guarantee the workmanship on every project.</p>']));
    assert.equal(r.hit, true);
    assert.ok(r.lines.some((l) => l.rule === 'legal-consent-word'));
  });
});

// gh-1701 criterion 1 (2026-09-08): the three false-positive SHAPES from the
// issue's measurement table, each asserted by name so a regression in any one
// of them is caught individually instead of buried in an aggregate `hit`.
//
// Measured against predicate.mjs on main (de65261) before this PR, node --test:
//   SHAPE 1 (html <script> // comment, word rule)      -> hit=true  ["legal-consent-word"]  FALSE POSITIVE
//   SHAPE 2 (py docstring line, tools/ harness path)    -> hit=false []                      already silent
//   SHAPE 3 (py test-fixture money identifier, tools/)  -> hit=false []                      already silent
// Shapes 2 and 3 were already silenced by the 2026-09-06 HARNESS_PATH_RES
// `currency-only` scoping (word rules and MONEY_IDENT_RE never run on a
// harness path at all, comment or not) -- they are asserted here as a
// regression guard, not because this PR changes their behaviour. Only SHAPE 1
// requires a predicate change; its fixture is the one that flips from failing
// to passing across this diff.
describe('gh-1701 criterion 1 -- the three false-positive shapes (2026-09-08)', () => {
  it('SHAPE 1: a `//` comment inside a .html <script> block does not fire the word rules', () => {
    const d = [
      'diff --git a/contractor-opportunities.html b/contractor-opportunities.html',
      '--- a/contractor-opportunities.html',
      '+++ b/contractor-opportunities.html',
      '@@ -1,3 +1,4 @@',
      ' <script>',
      '   function foo() {',
      '+    // the pay button was load-bearing; keep that guarantee explicitly.',
      '     bar();',
      '',
    ].join('\n');
    const r = detectLegalMoneyContent(d);
    assert.equal(r.hit, false, `expected silence, got ${JSON.stringify(r.lines)}`);
  });

  it('SHAPE 1b: a `/* */` comment inside a .html <script> block does not fire the word rules', () => {
    const d = [
      'diff --git a/contractor-opportunities.html b/contractor-opportunities.html',
      '--- a/contractor-opportunities.html',
      '+++ b/contractor-opportunities.html',
      '@@ -1,3 +1,4 @@',
      ' <script>',
      '   function foo() {',
      '+    /* keep that guarantee explicitly */',
      '     bar();',
      '',
    ].join('\n');
    const r = detectLegalMoneyContent(d);
    assert.equal(r.hit, false, `expected silence, got ${JSON.stringify(r.lines)}`);
  });

  it("SHAPE 1 control: the same page's HTML TEXT NODE (outside <script>) still fires", () => {
    const d = [
      'diff --git a/contractor-opportunities.html b/contractor-opportunities.html',
      '--- a/contractor-opportunities.html',
      '+++ b/contractor-opportunities.html',
      '@@ -1,4 +1,5 @@',
      ' <script>',
      '   // keep that guarantee explicitly -- inside the block, must stay silent',
      ' </script>',
      '+<p>We guarantee the workmanship on every project.</p>',
      '',
    ].join('\n');
    const r = detectLegalMoneyContent(d);
    assert.equal(r.hit, true, `expected the text-node line to still fire, got ${JSON.stringify(r.lines)}`);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].rule, 'legal-consent-word');
    assert.ok(r.lines[0].text.startsWith('<p>'), r.lines[0].text);
  });

  it('SHAPE 2: a Python docstring line under a tools/ harness path does not fire (already currency-only scoped)', () => {
    const d = 'diff --git a/tools/inline_handler_attr_check.py b/tools/inline_handler_attr_check.py\n--- a/tools/inline_handler_attr_check.py\n+++ b/tools/inline_handler_attr_check.py\n@@ -1,1 +1,2 @@\n x\n+  is a guaranteed break (it always emits the same shape)\n';
    const r = detectLegalMoneyContent(d);
    assert.equal(r.hit, false, `expected silence, got ${JSON.stringify(r.lines)}`);
  });

  it('SHAPE 3: a money-identifier-shaped test-fixture literal under tools/ does not fire (already currency-only scoped)', () => {
    const d = 'diff --git a/tools/inline_handler_attr_check.py b/tools/inline_handler_attr_check.py\n--- a/tools/inline_handler_attr_check.py\n+++ b/tools/inline_handler_attr_check.py\n@@ -1,1 +1,2 @@\n x\n+    ("gh1693-upgrade-pay", False, "confirmUpgradePayment shape"),\n';
    const r = detectLegalMoneyContent(d);
    assert.equal(r.hit, false, `expected silence, got ${JSON.stringify(r.lines)}`);
  });
});
