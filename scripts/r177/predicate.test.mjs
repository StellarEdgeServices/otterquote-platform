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
