-- ROLLBACK for 20260904132600_gh1532_claims_status_check.sql
--
-- Drops the CHECK constraint added by the forward migration. Reversible
-- with no data loss -- no rows are altered by either half, only the
-- constraint's presence/absence.

ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_status_check;
