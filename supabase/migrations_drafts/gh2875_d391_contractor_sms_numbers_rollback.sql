-- STATUS (gh-1438, as of 2026-10-19T22:51:02Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2875_d391_contractor_sms_numbers
-- EVIDENCE: drafted 2026-10-19 under #2875 with its forward file; proven on a throwaway Postgres only (supabase/tests/gh2875_d391_contractor_sms_numbers_proof_run.sh).
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Drops every object the forward file creates, in dependency order. DATA LOSS WARNING: once any Edge Function has written a
-- verification or suppression row, dropping these tables destroys consent and opt-out records that the LEGAL-READ (#2875
-- 6256074958) says must be retained (life of number + 4 years; suppression min. 5 years). After the first real row exists,
-- export the five tables before running this, or do not run it.
BEGIN;
DROP FUNCTION IF EXISTS public.contractor_textable_numbers(uuid);
DROP TABLE IF EXISTS public.contractor_sms_staff_actions;
DROP TABLE IF EXISTS public.sms_suppression_list;
DROP TABLE IF EXISTS public.contractor_sms_number_preferences;
DROP TABLE IF EXISTS public.contractor_sms_numbers;
DROP FUNCTION IF EXISTS public.contractor_sms_numbers_before_write();
DROP FUNCTION IF EXISTS public.contractor_sms_numbers_promote_primary();
DROP TABLE IF EXISTS public.sms_disclosure_versions;
COMMIT;
