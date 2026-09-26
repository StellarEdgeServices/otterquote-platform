/**
 * gh-2004 (static twins) — dashboard.html's auto-create-draft path and
 * repair-intake.html's direct-entry path must never insert a `claims` row
 * with no address when reached with no existing claim. Mirrors the React
 * fix (PR #2209, use-dashboard-data.ts / use-repair-intake-data.ts): no
 * claim -> redirect to trade-selector's address step, never an insert.
 *
 * Static grep-based guard (no test harness exists in this repo for these
 * files — both are large legacy HTML pages with inline <script>, not
 * separate js/ modules a vm context can load in isolation). Asserts against
 * the raw source text of the shipped files.
 *
 * Run: node tests/gh2004-static-no-addressless-claim.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const repairIntakeSrc = fs.readFileSync(path.join(ROOT, 'repair-intake.html'), 'utf8');

// ---- dashboard.html: useLatestClaim's static twin ----
{
  // The no-claim branch must redirect to trade-selector, not insert, and must
  // be gated to the genuinely-no-claim case (no error, or PGRST116) — a real
  // lookup error must fall through to the local-default block instead
  // (gh-2004 must-fix 1: a non-PGRST116 error must NOT redirect).
  const noClaimBlockMatch = dashboardSrc.match(/if \(!currentClaim && \(!error \|\| error\.code === 'PGRST116'\)\) \{[\s\S]*?\n\s{10}\}\n/);
  ok(!!noClaimBlockMatch, "dashboard.html: the no-claim redirect is gated on (!error || error.code === 'PGRST116')");
  const block = noClaimBlockMatch ? noClaimBlockMatch[0] : '';
  ok(/window\.location\.href\s*=\s*['"]https:\/\/app\.otterquote\.com\/trade-selector['"]/.test(block),
    'dashboard.html: no-claim branch redirects to https://app.otterquote.com/trade-selector');
  ok(!/\.from\(['"]claims['"]\)\s*\n?\s*\.insert\(/.test(block),
    'dashboard.html: no-claim branch no longer calls claims.insert(...) at all');
  ok(!/damage_type:\s*['"]roof['"]/.test(block),
    'dashboard.html: the addressless auto-create payload ({status:"draft", damage_type:"roof"}) is gone');

  // The fall-through local-default block (for a genuine, non-PGRST116 error)
  // must still exist and be reachable — i.e. not preceded by an unconditional
  // return for every !currentClaim case.
  ok(/If we STILL don't have a claim[\s\S]{0,400}if \(!currentClaim\) \{/.test(dashboardSrc),
    'dashboard.html: the local-default-claim fallback block is still present for a real lookup error');
}

// ---- dashboard.html: must-fix 1, behavioral — an error lookup must NOT redirect ----
{
  const fnMatch = dashboardSrc.match(/ {6}async function loadClaimData\(\) \{[\s\S]*?\n {6}\}\n/);
  ok(!!fnMatch, 'dashboard.html: loadClaimData() function body located for behavioral test');

  function makeSb(claimsResult) {
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      in() { return chain; },
      not() { return chain; },
      single: async () => claimsResult,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return { from() { return chain; } };
  }

  async function runLoadClaimData(claimsResult) {
    const windowStub = { location: {} };
    const harnessSrc = `
      let currentClaim = null;
      let hoverOrder = null, hoverRebateOrder = null, currentWarrantyUrl = null;
      ${fnMatch[0]}
      return loadClaimData().then(() => currentClaim);
    `;
    const build = new Function('sb', 'currentUser', 'CONFIG', 'window', harnessSrc);
    const resultClaim = await build(makeSb(claimsResult), { id: 'test-user' }, { DEMO_MODE: false }, windowStub);
    return { resultClaim, redirectedTo: windowStub.location.href };
  }

  if (fnMatch) {
    {
      const { redirectedTo } = await runLoadClaimData({ data: null, error: null });
      ok(redirectedTo === 'https://app.otterquote.com/trade-selector',
        'dashboard.html behavior: no data, no error -> redirects to trade-selector');
    }
    {
      const { redirectedTo } = await runLoadClaimData({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
      ok(redirectedTo === 'https://app.otterquote.com/trade-selector',
        'dashboard.html behavior: PGRST116 (no rows found) -> redirects to trade-selector');
    }
    {
      // gh-2004 must-fix 1: a real (non-PGRST116) error must NOT redirect —
      // it must fall through to the local-default claim instead.
      const { redirectedTo, resultClaim } = await runLoadClaimData({ data: null, error: { code: '500', message: 'boom' } });
      ok(redirectedTo === undefined,
        'dashboard.html behavior (must-fix 1): a non-PGRST116 lookup error does NOT redirect');
      ok(!!resultClaim && resultClaim.id === null && resultClaim.status === 'draft',
        'dashboard.html behavior (must-fix 1): a non-PGRST116 lookup error falls through to the local-default claim');
    }
    {
      const claimRow = { id: 'claim-1', status: 'submitted', ready_for_bids: false };
      const { redirectedTo, resultClaim } = await runLoadClaimData({ data: claimRow, error: null });
      ok(redirectedTo === undefined, 'dashboard.html behavior: an existing claim row -> no redirect');
      ok(resultClaim?.id === 'claim-1', 'dashboard.html behavior: an existing claim row is loaded into currentClaim');
    }
  }
}

// ---- repair-intake.html: submitRepairIntake's static twin ----
{
  const noClaimIdBlockMatch = repairIntakeSrc.match(/if \(!claimId\) \{[\s\S]*?\n\s{16}\} else \{/);
  ok(!!noClaimIdBlockMatch, 'repair-intake.html: the `if (!claimId)` block is present and parses as a single block');
  const block = noClaimIdBlockMatch ? noClaimIdBlockMatch[0] : '';
  ok(/window\.location\.href\s*=\s*['"]https:\/\/app\.otterquote\.com\/trade-selector['"]/.test(block),
    'repair-intake.html: no-claimId branch redirects to https://app.otterquote.com/trade-selector');
  ok(!/\.from\(['"]claims['"]\)\s*\n?\s*\.insert\(/.test(block),
    'repair-intake.html: no-claimId branch no longer calls claims.insert(...) at all');
  ok(!/job_type:\s*['"]repair['"]/.test(block),
    'repair-intake.html: the addressless repair-claim insert payload is gone from this branch');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
