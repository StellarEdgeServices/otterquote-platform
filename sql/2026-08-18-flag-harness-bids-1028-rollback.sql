-- ============================================================================
-- Rollback for: 2026-08-18-flag-harness-bids-1028.sql — GitHub #1028
-- ============================================================================
-- Restores is_test = false for exactly the rows this backfill touched.
-- Safe to run even if some rows were independently flagged test by other
-- means afterward — this only reverts to false, it does not re-flag anything.

UPDATE public.activity_log
   SET is_test = false
 WHERE user_id = '189b85ad-0ab0-4e54-9083-c51c3ef42a1d'
   AND is_test = true;

UPDATE public.quotes
   SET is_test = false
 WHERE contractor_id = 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'
   AND is_test = true;
-- ============================================================================
