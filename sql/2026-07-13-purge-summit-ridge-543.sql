-- =============================================================================
-- PURGE: Summit Ridge Exteriors, LLC (PFW-regenerated test contractor)
--        + PFW walk claim a39a37a2-efec-46b0-bca7-6dbc2027d45b (mislabeled is_test=false)
-- GitHub issue: #543 items 1-2
-- Approval: CEO (Dustin) 2026-07-13, explicit per D-220 — supersedes the
--   R-097 24-hour wait (issue #543 comment, 2026-07-13 W1 session).
-- Pattern: June 2026 purge (ClickUp 86e1qhy5d) — two transactions.
-- Companion rollback: sql/2026-07-13-purge-summit-ridge-543-rollback.sql
-- Executed 2026-07-13 via Supabase MCP (Claude Code launch repair batch).
--
-- Scope (verified against live prod 2026-07-13 before execution):
--   contractors                 1 row   ea72739c-b472-4f66-ba3e-1fd3fba8a3a8
--   claims (DELETE)             1 row   a39a37a2-efec-46b0-bca7-6dbc2027d45b (contract_signed, is_test=false)
--   claims (UNLINK only)        1 row   f3bfb1f9-8d5a-42fb-9b35-11167957842a (awarded, is_test=true)
--                                       selected_contractor_id -> NULL
--   quotes                      3 rows  (1 via claim CASCADE, 2 via contractor CASCADE)
--   fee_acceptances             3 rows  (manual — NO ACTION FK)
--   payment_failures            4 rows  (manual — NO ACTION FK)
--   notifications               8 rows  (6 on the claim + 2 on the SR user, manual)
--   contractor_templates        2 rows  (CASCADE)
--   contractor_payment_methods  1 row   (CASCADE)
--   contractor_licenses         1 row   (CASCADE)
--   auth.users                  1 row   f17b7aa8-a00a-4208-95a7-e722c1bc9f7a
--                                       (CASCADE: profiles, activity_log x4,
--                                        identities, sessions)
-- NOT touched: claim 73208937 (active, is_test=false — outside approved scope;
--   it loses Summit Ridge's quote via CASCADE), Martinez & Sons, the two
--   @otterquote-internal.test E2E contractors, homeowner auth user 5556e95a
--   (dustinstohler1+pfw alias), storage objects (COI/WC-cert/template PDFs
--   remain in buckets — inert without DB rows).
-- =============================================================================

-- ---------- Transaction 1: business rows ----------
BEGIN;

-- Preflight: abort unless live state matches the approved scope exactly.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM contractors
   WHERE id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' AND email = 'testcontractor@otterquote.com';
  IF n <> 1 THEN RAISE EXCEPTION 'preflight: Summit Ridge contractor row not found'; END IF;

  SELECT count(*) INTO n FROM claims WHERE id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 1 THEN RAISE EXCEPTION 'preflight: claim a39a37a2 not found'; END IF;

  SELECT count(*) INTO n FROM quotes
   WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 3 THEN RAISE EXCEPTION 'preflight: expected 3 quotes, found %', n; END IF;

  SELECT count(*) INTO n FROM fee_acceptances
   WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 3 THEN RAISE EXCEPTION 'preflight: expected 3 fee_acceptances, found %', n; END IF;

  SELECT count(*) INTO n FROM payment_failures
   WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 4 THEN RAISE EXCEPTION 'preflight: expected 4 payment_failures, found %', n; END IF;

  SELECT count(*) INTO n FROM notifications
   WHERE claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b' OR user_id = 'f17b7aa8-a00a-4208-95a7-e722c1bc9f7a';
  IF n <> 8 THEN RAISE EXCEPTION 'preflight: expected 8 notifications, found %', n; END IF;

  SELECT count(*) INTO n FROM disputes
   WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 0 THEN RAISE EXCEPTION 'preflight: unexpected disputes rows: %', n; END IF;

  SELECT count(*) INTO n FROM admin_dispute_queue
   WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
  IF n <> 0 THEN RAISE EXCEPTION 'preflight: unexpected admin_dispute_queue rows: %', n; END IF;

  -- Martinez & Sons guard: the only real contractor must exist untouched.
  SELECT count(*) INTO n FROM contractors
   WHERE email = 'martinezsonsconstruction2000@gmail.com';
  IF n <> 1 THEN RAISE EXCEPTION 'preflight: Martinez & Sons row missing'; END IF;
END $$;

-- Unlink the surviving is_test=true walk claim from Summit Ridge.
UPDATE claims SET selected_contractor_id = NULL
 WHERE id = 'f3bfb1f9-8d5a-42fb-9b35-11167957842a'
   AND selected_contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8';

-- NO ACTION dependents first.
DELETE FROM notifications    WHERE claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b' OR user_id = 'f17b7aa8-a00a-4208-95a7-e722c1bc9f7a';
DELETE FROM fee_acceptances  WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
DELETE FROM payment_failures WHERE contractor_id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8' OR claim_id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';

-- Claim (CASCADE: its quote), then contractor (CASCADE: remaining quotes,
-- templates, payment methods, licenses, certifications, cert verifications).
DELETE FROM claims      WHERE id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';
DELETE FROM contractors WHERE id = 'ea72739c-b472-4f66-ba3e-1fd3fba8a3a8';

COMMIT;

-- ---------- Transaction 2: auth user ----------
BEGIN;
DELETE FROM auth.users
 WHERE id = 'f17b7aa8-a00a-4208-95a7-e722c1bc9f7a'
   AND email = 'testcontractor@otterquote.com';
COMMIT;

-- ---------- Post-delete verification (run separately) ----------
-- SELECT company_name, email, status FROM contractors ORDER BY created_at;
--   -> exactly 3 rows: Martinez & Sons Construction LLC (pending_approval),
--      Test Roofing Co (E2E), Test D210 Roofing Co (E2E)
-- SELECT count(*) FROM claims WHERE id = 'a39a37a2-efec-46b0-bca7-6dbc2027d45b';   -> 0
-- SELECT selected_contractor_id FROM claims WHERE id = 'f3bfb1f9-8d5a-42fb-9b35-11167957842a';  -> NULL
-- SELECT count(*) FROM auth.users WHERE email = 'testcontractor@otterquote.com';  -> 0
