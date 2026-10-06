-- gh-1438 reconciliation (cto61, 2026-10-06T19:47:53Z): renamed from 20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button.sql to the REAL applied ledger version.
-- Ledger row: supabase_migrations.schema_migrations version=20261003020713 (SELECT-only read 2026-10-06). Content check: statements normalized md5 6943b341 = file.
-- Executable SQL body unchanged; only the filename version prefix and this banner changed.
-- gh-1925 (CEO ruling #2304 comment 5963898698, item 2): widen the profiles.ad_sharing_opt_out_source CHECK to also allow
-- 'in_page_button' (the privacy.html section 12 "Opt out of sale/sharing" button), so that opt-out is recorded with its real
-- source instead of NULL. No wording involved. CEO classified this tier 3A; see the PR body for the 3A/3B note
-- (a DROP + ADD of a CHECK is technically an ALTER).
--
-- WHAT. Replace profiles_ad_sharing_opt_out_source_check (gh-2107) with a superset: gpc_header, gpc_client, support_email, in_page_button.
-- Strictly widening: every row valid before is valid after. No data change, no column change, RLS untouched.
--
-- ORDER OF OPERATIONS. Not load-bearing for correctness: the privacy.html section 12 PATCH retries once without the source on a
-- 23514 check violation, so the opt-out flag lands whether this is applied before or after the deploy. This migration only adds
-- source attribution (rows written before it is applied carry a NULL source).
--
-- PATTERN. NOT VALID + VALIDATE, same shape as gh-1387 / gh-1532. Note: DROP CONSTRAINT and ADD CONSTRAINT both take ACCESS
-- EXCLUSIVE on profiles, and VALIDATE runs inside the same transaction while that lock is still held, so this split does not
-- avoid blocking here -- the table is small and lock_timeout (5s) bounds the wait. DROP and ADD happen in one transaction,
-- so other sessions see the old or the new constraint, never none.
--
-- Companion rollback: supabase/migrations_rollbacks/20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button_rollback.sql
-- Pre-flight: supabase/migrations/20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button_pre-flight.md

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ad_sharing_opt_out_source_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ad_sharing_opt_out_source_check
  CHECK (ad_sharing_opt_out_source IS NULL
         OR ad_sharing_opt_out_source IN ('gpc_header', 'gpc_client', 'support_email', 'in_page_button')) NOT VALID;

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_ad_sharing_opt_out_source_check;

COMMENT ON COLUMN public.profiles.ad_sharing_opt_out_source IS
  'gh-2107 / gh-1925: how the opt-out was recorded: gpc_header, gpc_client, support_email or in_page_button (privacy.html section 12 button).';

COMMIT;
