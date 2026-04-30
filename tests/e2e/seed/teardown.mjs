/**
 * OtterQuote E2E Teardown Script
 *
 * Cleans up test data created during a test run. Run automatically after
 * tests complete, or manually via `npm run teardown`.
 *
 * What it deletes:
 *   - All quotes (bids) submitted by the test contractor on the test claim
 *   - All claims belonging to the test homeowner
 *
 * What it DOES NOT delete:
 *   - Test auth users (homeowner + contractor) — these persist across runs
 *     so re-seeding is fast. Run seed.mjs again to recreate the claim.
 *   - Profile rows — same reason.
 *   - Contractor business record — same reason.
 *
 * To do a full reset (delete auth users too), run the SQL:
 *   DELETE FROM auth.users WHERE email IN (
 *     'test-homeowner@otterquote-internal.test',
 *     'test-contractor@otterquote-internal.test'
 *   );
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.test') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const STATE_FILE = resolve(__dirname, '..', '.test-state.json');

async function teardown() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OtterQuote E2E Teardown');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!existsSync(STATE_FILE)) {
    console.log('  No .test-state.json found — nothing to tear down.\n');
    return;
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));

  // ── Delete test bids ────────────────────────────────────────────────────
  if (state.contractorId && state.testClaimId) {
    const { error: qErr, count } = await supabase
      .from('quotes')
      .delete({ count: 'exact' })
      .eq('contractor_id', state.contractorId)
      .eq('claim_id', state.testClaimId);

    if (qErr) {
      console.warn('  ⚠️  Quote cleanup warning:', qErr.message);
    } else {
      console.log(`  ✅ Test bids deleted (${count ?? 0} rows)`);
    }
  }

  // ── Delete test claims ───────────────────────────────────────────────────
  if (state.homeownerUserId) {
    const { error: clErr, count } = await supabase
      .from('claims')
      .delete({ count: 'exact' })
      .eq('user_id', state.homeownerUserId);

    if (clErr) {
      console.warn('  ⚠️  Claim cleanup warning:', clErr.message);
    } else {
      console.log(`  ✅ Test claims deleted (${count ?? 0} rows)`);
    }
  }

  console.log('\n  ✅ Teardown complete.\n');
  console.log(
    '  Note: auth users and profiles are retained for faster re-seeding.\n' +
      '  Run `npm run seed` to recreate test claim for next run.\n'
  );
}

// Allow use as Playwright globalTeardown (default export) AND direct invocation
export default teardown;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  teardown().catch((e) => {
    console.error('\n❌ Teardown failed:', e.message);
    process.exit(1);
  });
}
