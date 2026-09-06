// node --test scripts/r120/verify.scope.test.mjs   (Node 20+, no deps)
//
// gh-1701 (CTO RUN 27, 2026-09-06): R-120 predicate SCOPE.
//
// Companion to verify.test.mjs, which covers the signature half and the rule
// vocabulary. This file covers WHICH FILES and WHICH LINES the rules are allowed
// to look at, because that is where the gate was misfiring: measured against the
// real diffs of the 15 open PRs on 2026-09-06, five PRs were blocking the merge
// queue on lines that were not money, legal, consent or pricing content.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectR120Content, COPY_GUARD_FILES, scanModeFor } from './verify.mjs';

// ---------------------------------------------------------------------------
// gh-1701 (CTO RUN 27, 2026-09-06): predicate SCOPE.
//
// Measured against the real diffs of the 15 open PRs. Every N* fixture below was
// observed FIRING against the predicate as it stood on main at 0f21b22, and every
// P* fixture must keep firing after the change — a fix that quiets the false
// positives by also quieting the true ones is a regression, not a fix.
// ---------------------------------------------------------------------------
describe('detectR120Content — predicate scope (gh-1701, 2026-09-06)', () => {
  const diff = (file, lines) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${lines.length + 1} @@\n x\n` +
    lines.map((l) => (l.startsWith('-') ? l : '+' + l)).join('\n') + '\n';
  const hit = (file, lines) => detectR120Content(diff(file, lines));

  // ---- negative controls: each of these FIRED before this change -----------
  it('N1 does NOT fire on Playwright fixtures — *.spec.* is excluded like *.test.* (#1720, 19 hits)', () => {
    assert.equal(hit('tests/e2e/smoke/entry-point-reachability.spec.ts', [
      "  const PAYOUT = { id: 'reach-payout-1', amount: 250, payout_type: 'commission_referral' };",
      "  await assertEntryPointReachable(page, loc, 'upgrade-pay', 'confirmUpgradePayment', []);",
    ]).hit, false);
  });

  it("N2 does NOT fire on R-120's OWN text quoted in a script (#1735)", () => {
    assert.equal(hit('scripts/r120-gate-armed-check.py', [
      '    "     touching legal wording, consent, pricing, or money can merge unsigned",',
    ]).hit, false);
  });

  it('N3 does NOT fire on "credit/billing" in a --help string (#1733)', () => {
    assert.equal(hit('scripts/netlify-deploy-drift.py', [
      '    "  redeploy everything -- diagnose the specific site (Netlify credit/billing,"',
    ]).hit, false);
  });

  it('N4 does NOT fire on an `is_test` column in a DDL trace (#1683)', () => {
    assert.equal(hit('supabase/migrations/20260904212048_gh1585_funnel_abandonment_facts.sql', [
      '  is_test                boolean     NOT NULL,',
    ]).hit, false);
  });

  it('N5 does NOT fire on detector filenames listed in a dict (#1742)', () => {
    assert.equal(hit('scripts/detector-negative-control-check.py', [
      '    "scripts/check-partner-consent-link.py": "no negative-control test yet (pre-gh-1738)",',
      '    "scripts/check-payout-timing-copy-drift.py": "no negative-control test yet (pre-gh-1738)",',
    ]).hit, false);
  });

  it('N6 does NOT fire on a COMMENT ON docstring naming a money function', () => {
    assert.equal(hit('supabase/migrations/20260910_x.sql', [
      "COMMENT ON FUNCTION public.get_platform_fee_percentage() IS 'reads the platform fee';",
    ]).hit, false);
  });

  // ---- positive controls: the gate MUST keep firing ------------------------
  it('P1 fires on a price change in HTML copy — the $15 credit sentence (#1692)', () => {
    const r = hit('faq.html', ['          <p>Add professional measurements for <strong>$15</strong>, rebated in full when your project is completed.</p>']);
    assert.equal(r.hit, true);
    assert.ok(r.lines.some((l) => l.rule === 'currency-amount'));
  });

  it('P2 fires on a warranty claim in HTML copy', () => {
    assert.equal(hit('contractor-dashboard.html', ['            <p>Each verified certification unlocks the matching warranty tier in your bids.</p>']).hit, true);
  });

  it('P3 fires on a platform fee percentage in an edge function', () => {
    assert.equal(hit('supabase/functions/create-payment-intent/index.ts', [
      '          .eq("key", "platform_fee_percentage")',
      '        const platformFeeCents = Math.round(subtotalCents * 0.12);',
    ]).hit, true);
  });

  it('P4 fires on a refund path in an edge function', () => {
    assert.equal(hit('supabase/functions/rescind-bid/index.ts', [
      '      await stripe.refunds.create({ payment_intent: pi.id, amount: refundCents });',
    ]).hit, true);
  });

  it('P5 fires on a consent string in HTML copy', () => {
    assert.equal(hit('privacy-policy.html', ['          <p>By using our services, you consent to the transfer and processing of your information.</p>']).hit, true);
  });

  it('P6 fires when a copy guard under scripts/ is weakened (COPY_GUARD_FILES carve-out)', () => {
    assert.equal(hit('scripts/check-credential-claims.py', [
      '-BANNED = ["licensed, insured", "licensed and insured", "vetted contractors"]',
      'BANNED = ["licensed and insured"]',
    ]).hit, true);
  });

  it('P7 fires when a copy guard under tools/ drops its disclaimer assertion', () => {
    assert.equal(hit('tools/partner_parity_check.py', [
      '-            failures.append(f"{page}.html: missing D-266 disclaimer verbatim text (d266_disclaimer)")',
      '            pass',
    ]).hit, true);
  });

  it('P8 fires ONCE per file on a GRANT/REVOKE over a money-path function (#1634: 20 rows -> 1)', () => {
    const r = hit('supabase/migrations/20260910_grant.sql', [
      'GRANT EXECUTE ON FUNCTION public.process_contractor_payout() TO anon;',
      'GRANT EXECUTE ON FUNCTION public.apply_referral_commission() TO anon;',
      'REVOKE EXECUTE ON FUNCTION public.get_platform_fee_percentage() FROM anon;',
    ]);
    assert.equal(r.hit, true);
    assert.equal(r.lines.filter((l) => l.rule === 'money-permission').length, 1);
  });

  it('P9 fires on a hard-coded price added under scripts/ — currency survives harness scope', () => {
    assert.equal(hit('scripts/seed-demo-data.py', ['MEASUREMENT_PRICE_CENTS = 1500']).hit, true);
  });

  it('P10 fires on any change to the gate file itself (this PR needs a signature)', () => {
    const r = hit('scripts/r120/verify.mjs', ['const MONEY_IDENT_RE = /(payment|payout)/i;']);
    assert.equal(r.hit, true);
    assert.ok(r.lines.some((l) => l.rule === 'gate-file'));
  });

  it('scanModeFor: harness paths are currency-only, copy guards are full, specs are none', () => {
    assert.equal(scanModeFor('tests/e2e/helpers/seed.ts'), 'currency-only');
    assert.equal(scanModeFor('scripts/netlify-deploy-drift.py'), 'currency-only');
    assert.equal(scanModeFor('tools/inline_handler_attr_check.py'), 'currency-only');
    assert.equal(scanModeFor('tools/partner_parity_check.py'), 'full');
    assert.equal(scanModeFor('scripts/check-credential-claims.py'), 'full');
    assert.equal(scanModeFor('tests/e2e/smoke/x.spec.ts'), 'none');
    assert.equal(scanModeFor('faq.html'), 'full');
    assert.equal(scanModeFor('scripts/r120/verify.mjs'), 'none'); // GATE_FILES: reported whole
  });

  // ---- the ratchet that keeps COPY_GUARD_FILES honest ----------------------
  // Harness paths lose the prose word rules, so a file under scripts/ or tools/
  // that HOLDS customer money/legal copy must be listed in COPY_GUARD_FILES or
  // R-120 goes blind to it. This walks the tree and fails loudly instead.
  it('COPY_GUARD_FILES covers every copy-holding file under scripts/ and tools/', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const COPY_VOCAB = /licensed, insured|licensed and insured|\bvetted\b|\bbonded\b|\bwarrant(y|ies)\b|\barbitration\b|public adjuster|\bdisclaimer\b|\bconsent\b|\brefunded?\b|\brebate|\bguarantee/i;
    const TEXT_EXT = /\.(py|m?[jt]s|sh|sql|html?|txt)$/i;
    const walk = (dir, acc = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__pycache__') walk(abs, acc); }
        else acc.push(abs);
      }
      return acc;
    };
    const missing = [];
    for (const base of ['scripts', 'tools']) {
      const dir = path.join(root, base);
      if (!fs.existsSync(dir)) continue;
      for (const abs of walk(dir)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (rel.startsWith('scripts/r120/')) continue;      // the gate's own directory is excluded
        if (/\.(test|spec)\.[^/]+$/i.test(rel)) continue;   // hard-excluded anyway
        if (!TEXT_EXT.test(rel)) continue;
        let body;
        try { body = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        if (COPY_VOCAB.test(body) && !COPY_GUARD_FILES.has(rel)) missing.push(rel);
      }
    }
    assert.deepEqual(missing, [],
      `These files under scripts/ or tools/ carry customer money/legal copy but are not in ` +
      `COPY_GUARD_FILES in scripts/r120/verify.mjs, so R-120's prose rules will not see them:\n  ` +
      missing.join('\n  ') +
      `\nAdd each one to COPY_GUARD_FILES (listing a file only makes the gate scan MORE), or, if it ` +
      `genuinely holds no customer copy, narrow the match rather than deleting this test.`);
  });
});
