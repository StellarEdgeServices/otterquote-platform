/**
 * Regression test for #817/#643 — js/auth.js getRole() partner branch.
 *
 * gh-909 (D-182 v113, 2026-08-19) update: getRole() used to implement the
 * contractor -> referral_agents -> profiles.role precedence inline across
 * three separate queries. That precedence now lives server-side in
 * `public.resolved_user_role` (a read-only SECURITY INVOKER view scoped to
 * auth.uid() — see supabase/migrations/v113_derived_role_view.sql), which
 * was branch-tested directly against the same cases this file used to
 * reconstruct via three mocked tables (see the migration's pre-flight doc
 * for those results: plain homeowner, plain contractor, partner-only
 * linked, partner-only unclaimed, dual-role, and the 3 known orphan
 * role='contractor' rows). This file now verifies a narrower but still
 * real thing: that getRole() correctly forwards whatever
 * resolved_user_role.derived_role says, unmodified, and fails closed
 * (returns null, not a stale/wrong value) on a query error. The original
 * root-cause scenario (#817/#643 — a partner-only or dual-role account
 * resolving wrong) is still exercised here, just via a single mocked view
 * row instead of three mocked tables, since that is the real integration
 * point in the code today.
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
 * Build a fresh vm sandbox with a mock `sb` client whose
 * `resolved_user_role` table is seeded with a single row (or an error) per
 * test case, and `Auth.getUser()` overridden to resolve a fixed user.
 */
function makeSandbox({ derivedRole, queryError }) {
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
        if (table === 'resolved_user_role') {
          if (queryError) {
            return Promise.resolve({ data: null, error: queryError });
          }
          return Promise.resolve({ data: { derived_role: derivedRole }, error: null });
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
  // Case 1: partner-only account — the original #817 fix, now server-side.
  // The view resolves this to the agent_type; getRole() must forward it
  // unmodified.
  {
    const sandbox = makeSandbox({ derivedRole: 'home_inspector' });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'home_inspector',
      `partner-only account: expected getRole() to forward 'home_inspector', got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: partner-only account → view resolves agent_type, getRole() forwards it unmodified');
  }

  // Case 2: dual-role account — the view already applied contractor
  // precedence; getRole() must not re-derive or override it.
  {
    const sandbox = makeSandbox({ derivedRole: 'contractor' });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'contractor',
      `dual-role account: expected getRole() to forward 'contractor' (view-side precedence), got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: dual-role account → view resolves \'contractor\' (precedence), getRole() forwards it unmodified');
  }

  // Case 3: plain homeowner — unchanged fallback, now via the view's
  // profiles.role fallback branch.
  {
    const sandbox = makeSandbox({ derivedRole: 'homeowner' });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, 'homeowner',
      `plain homeowner: expected getRole() to forward 'homeowner', got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: plain homeowner → view falls back to profiles.role, getRole() forwards it unmodified');
  }

  // Case 4 (new, gh-909 2026-08-19 approval): a user with no contractor/
  // partner record who owns a claim resolves 'homeowner' via the view's new
  // claims-derived-homeowner fact, even where profiles.role could in
  // principle be unset. getRole() must still just forward it.
  {
    const sandbox = makeSandbox({ derivedRole: 'homeowner' });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(role, 'homeowner');
    console.log('✓ PASS: claims-derived homeowner (gh-909 new behavior) → getRole() forwards \'homeowner\'');
  }

  // Case 5: view query errors (network, RLS, JWT expiry) — getRole() must
  // fail closed to null, not fall through to a stale/wrong value. Mirrors
  // the pre-#909 fail-closed handling of the old contractor-lookup error
  // branch (bug fix: May 7, 2026), now applied to the single view read.
  {
    const sandbox = makeSandbox({ queryError: { code: '500', message: 'simulated failure' } });
    const role = await sandbox.window.Auth.getRole();
    assert.equal(
      role, null,
      `view query error: expected getRole() to fail closed to null, got ${JSON.stringify(role)}`
    );
    console.log('✓ PASS: resolved_user_role query error → getRole() fails closed to null (not a stale fallthrough)');
  }

  console.log('\n✓ All getRole() / resolved_user_role forwarding cases pass.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ FAIL: unexpected error', err);
  process.exit(1);
});
