-- gh-1925 (CEO ruling #2304 comment 5963898698, item 2): widen the profiles.ad_sharing_opt_out_source CHECK to also allow
-- 'in_page_button' (the privacy.html section 12 "Opt out of sale/sharing" button), so that opt-out is recorded with its real
-- source instead of NULL. No wording involved. CEO classified this tier 3A; see the PR body for the 3A/3B note
-- (a DROP + ADD of a CHECK is technically an ALTER).
--
-- WHAT. Replace profiles_ad_sharing_opt_out_source_check (gh-2107) with a superset: gpc_header, gpc_client, support_email, in_page_button.
-- Strictly widening: every row valid before is valid after. No data change, no column change, RLS untouched.
--
-- ORDER OF OPERATIONS (load-bearing). Apply this BEFORE the static privacy.html change that PATCHes
-- ad_sharing_opt_out_source='in_page_button' reaches production. Until the constraint is widened that PATCH would be rejected by the
-- OLD check and a signed-in visitor's cross-device flag write would fail (the cookie opt-out would still work).
--
-- PATTERN. NOT VALID + VALIDATE split, same as gh-1387 / gh-1532. ADD ... NOT VALID takes a brief lock and does not scan;
-- VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE (does not block reads/writes). DROP and ADD happen in one transaction,
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
