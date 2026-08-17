/**
 * Regression test for #817/#643 — js/auth.js getRole() partner branch.
 *
 * Root cause (live-verified 2026-08-14, issue #817 comment 5288476400):
 * getRole() checked the `contractors` table, then fell back to
 * `profiles.role`, and never queried `referral_agents` at all. Live prod SQL
 * confirmed every real partner-only account (no contractors row) carries
 * `profiles.role = 'homeowner'`, so getRole() returned 'homeowner' for a
 * partner — and for a dual-role account (contractor + active
 * referral_agents, e.g. dustinstohler1@gmail.com) it returned 'contractor'
 * unconditionally, which is what sent that account to
 * /contractor-dashboard.html instead of /partner-dashboard.html.
 *
 * This test loads the real js/auth.js source into a minimal vm context with
 * a mock Supabase client and asserts getRole()'s three cases:
 *   1. Partner-only account (no contractors row, active referral_agents row)
 *      -> returns the referral_agents.agent_type value (the fix).
 *   2. Dual-role account (contractors row + active referral_agents row)
 *      -> still returns 'contractor' (precedence unchanged — surface-aware
 *      callers like auth-callback.html's intent check take priority over
 *      this single-value getter, not getRole() itself).
 *   3. Plain homeowner (no contractors row, no referral_agents row)
 *      -> still falls back to profiles.role (unchanged).
 *
 * Run: node tests/auth-partner-role-resolution.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

/**
 * Build a fresh vm sandbox with a mock `sb` client whose `contractors` and
 * `referral_agents` tables are seeded per test case, and `Auth.getUser()`
 * overridden to resolve a fixed user — isolating getRole() from
 * getSession()'s race-guard logic, which #602's test already covers.
 */
function makeSandbox({ contractorRow, agentRow, profileRole }) {
  const sandbox = {
    window: {},
    console,
    setTimeout,
    Promise,
  };

  function tableQuery(table) {
    return {
      select() { return this; },
      eq() { return this; },
      single() {
        if (table === 'contractors') {
          return Promise.resolve(
            contractorRow
              ? { data: contractorRow, error: null }
              : { data: null, error: { code: 'PGRST116', message: '0 rows' } }
          );
        }
        if (table === 'referral_agents') {
          return Promise.resolve(
            agentRow
              ? { data: agentRow, error: null }
              : { data: null, error: { code: 'PGRST116', message: '0 rows' } }
          );
        }
        if (table === 'profiles') {
          return Promise.resolve({ data: { role: profileRole }, error: null });
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
  }

  sandbox.sb = { from: (table) => tableQuery(table) };
  sandbox.window.sb = sandbox.sb;
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox, { filename: 'js/auth.js' });
  sandbox.window.Auth.getUser = async () => ({ id: 'user-multirole-test' });
  return sandbox;
}

async function main() {
  // Case 1: partner-only account — the fix.
  {
    const sandbox = makeSandbox({
      contractorRow: null,
      agentRow: { agent_type: 'home_inspector' },
      profileRole: 'homeowner',
    });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'home_inspector',
      `partner-only account: expected getRole() to return 'home_inspector', got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: partner-only account (no contractors row, active referral_agents) → getRole() returns agent_type');
  }

  // Case 2: dual-role account — precedence unchanged.
  {
    const sandbox = makeSandbox({
      contractorRow: { id: 'contractor-multirole-test' },
      agentRow: { agent_type: 'home_inspector' },
      profileRole: 'contractor',
    });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'contractor',
      `dual-role account: expected getRole() to still return 'contractor' (precedence unchanged), got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: dual-role account (contractors + active referral_agents) → getRole() still returns \'contractor\'');
  }

  // Case 3: plain homeowner — unchanged fallback.
  {
    const sandbox = makeSandbox({
      contractorRow: null,
      agentRow: null,
      profileRole: 'homeowner',
    });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'homeowner',
      `plain homeowner: expected getRole() to fall back to profiles.role, got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: plain homeowner (no contractors, no referral_agents) → getRole() falls back to profiles.role');
  }

  console.log('\n✓ All getRole() partner-branch cases pass.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
