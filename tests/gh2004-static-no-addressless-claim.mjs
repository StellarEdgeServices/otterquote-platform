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
  // The no-claim branch must redirect to trade-selector, not insert.
  const noClaimBlockMatch = dashboardSrc.match(/if \(!currentClaim\) \{[\s\S]*?\n\s{10}\}\n/);
  ok(!!noClaimBlockMatch, 'dashboard.html: the first `if (!currentClaim)` block (auto-create site) is present and parses as a single block');
  const block = noClaimBlockMatch ? noClaimBlockMatch[0] : '';
  ok(/window\.location\.href\s*=\s*['"]https:\/\/app\.otterquote\.com\/trade-selector['"]/.test(block),
    'dashboard.html: no-claim branch redirects to https://app.otterquote.com/trade-selector');
  ok(!/\.from\(['"]claims['"]\)\s*\n?\s*\.insert\(/.test(block),
    'dashboard.html: no-claim branch no longer calls claims.insert(...) at all');
  ok(!/damage_type:\s*['"]roof['"]/.test(block),
    'dashboard.html: the addressless auto-create payload ({status:"draft", damage_type:"roof"}) is gone');
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
