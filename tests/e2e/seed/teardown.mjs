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

// @supabase/supabase-js eagerly resolves a WebSocket constructor for its
// Realtime client at construction time, even when no channel is ever opened.
// On Node < 22 (no native WebSocket global) and with the `ws` package removed
// (#658, CVE-2026-48779), that resolution throws before this script can run
// at all. This script never calls `.channel()`/`.subscribe()`, so a stub
// that is constructed-but-never-invoked satisfies the eager check without
// reintroducing `ws`.
class NoRealtimeTransportStub {
  constructor() {
    throw new Error(
      'Realtime transport unavailable: this client never opens a realtime channel.'
    );
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: NoRealtimeTransportStub },
  }
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
  let hadFailure = false;

  // ── Fetch claim ids owned by the test homeowner up front ─────────────────
  // Every downstream delete below targets these ids directly, instead of
  // assuming only the current run's testClaimId exists — teardown deletes
  // ALL claims for this user, so it must clear ALL of their FK children too.
  let claimIds = [];
  if (state.homeownerUserId) {
    const { data: claimRows, error: fetchErr } = await supabase
      .from('claims')
      .select('id')
      .eq('user_id', state.homeownerUserId);
    if (fetchErr) {
      console.error('  ❌ Failed to fetch claim ids for cleanup:', fetchErr.message);
      hadFailure = true;
    } else {
      claimIds = (claimRows ?? []).map((r) => r.id);
    }
  }

  // ── Delete every row with a NO ACTION FK to claims (#694) ────────────────
  // Postgres rejects claims.delete() while ANY of these still reference the
  // claim. Previously only fee_acceptances hit this in practice, but all 7
  // of these are NO ACTION — each must be cleared first or the claims
  // delete below is rejected by the FK and (before this fix) silently
  // swallowed by a catch-and-warn.
  const NO_ACTION_CHILD_TABLES = [
    'fee_acceptances',
    'adjuster_email_requests',
    'admin_dispute_queue',
    'disputes',
    'expansion_waitlist',
    'notifications',
    'payment_failures',
  ];

  if (claimIds.length > 0) {
    for (const table of NO_ACTION_CHILD_TABLES) {
      const { error, count } = await supabase
        .from(table)
        .delete({ count: 'exact' })
        .in('claim_id', claimIds);
      if (error) {
        console.error(`  ❌ ${table} cleanup failed:`, error.message);
        hadFailure = true;
      } else {
        console.log(`  ✅ Test ${table} deleted (${count ?? 0} rows)`);
      }
    }
  }

  // ── Delete hover_orders (also a NO ACTION FK; kept keyed on user_id — ────
  //    matches how seed.mjs writes it, and #689 confirmed this one already
  //    cleans up correctly with zero orphans)
  if (state.homeownerUserId) {
    const { error: hoErr, count: hoCount } = await supabase
      .from('hover_orders')
      .delete({ count: 'exact' })
      .eq('user_id', state.homeownerUserId);
    if (hoErr) {
      console.error('  ❌ hover_orders cleanup failed:', hoErr.message);
      hadFailure = true;
    } else {
      console.log(`  ✅ Test hover_orders deleted (${hoCount ?? 0} rows)`);
    }
  }

  // ── Delete test bids ────────────────────────────────────────────────────
  // (quotes cascades automatically on claim delete, but deleting explicitly
  // first keeps the logged count accurate about what this run actually did)
  if (state.contractorId && state.testClaimId) {
    const { error: qErr, count } = await supabase
      .from('quotes')
      .delete({ count: 'exact' })
      .eq('contractor_id', state.contractorId)
      .eq('claim_id', state.testClaimId);

    if (qErr) {
      console.error('  ❌ Quote cleanup failed:', qErr.message);
      hadFailure = true;
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
      console.error('  ❌ Claim cleanup failed:', clErr.message);
      hadFailure = true;
    } else if (claimIds.length > 0 && (count ?? 0) === 0) {
      // The exact failure mode that hid #694 for 34 days: rows were seeded
      // (claimIds is non-empty) but the delete removed zero of them. A
      // green teardown that deletes nothing must fail loudly, not warn.
      console.error(
        `  ❌ Claim cleanup deleted 0 rows but ${claimIds.length} claim(s) were present before teardown ran.`
      );
      hadFailure = true;
    } else {
      console.log(`  ✅ Test claims deleted (${count ?? 0} rows)`);
    }
  }

  console.log(
    hadFailure
      ? '\n  ❌ Teardown completed with one or more cleanup failures (see above).\n'
      : '\n  ✅ Teardown complete.\n'
  );
  console.log(
    '  Note: auth users and profiles are retained for faster re-seeding.\n' +
      '  Run `npm run seed` to recreate test claim for next run.\n'
  );

  if (hadFailure) {
    throw new Error(
      'Teardown completed with one or more cleanup failures — see warnings above. ' +
        'This must exit non-zero: a silent, incomplete teardown is what let #694 accumulate 200 rows in production.'
    );
  }
}

// Allow use as Playwright globalTeardown (default export) AND direct invocation
export default teardown;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  teardown().catch((e) => {
    console.error('\n❌ Teardown failed:', e.message);
    process.exit(1);
  });
}
