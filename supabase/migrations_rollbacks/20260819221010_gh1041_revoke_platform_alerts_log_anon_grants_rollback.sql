-- Rollback: 20260819221010_gh1041_revoke_platform_alerts_log_anon_grants
-- Reverts: 20260819221010_gh1041_revoke_platform_alerts_log_anon_grants.sql
-- WARNING: This restores the pre-fix over-permissive grant state
-- (anon full CRUD, authenticated full CRUD) on an internal ops-alerting
-- table. Should not be run except to diagnose an unforeseen regression
-- from the forward migration -- included per this repo's rollback-required
-- convention, not because reverting is ever the intended outcome.

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.platform_alerts_log TO anon;
GRANT INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.platform_alerts_log TO authenticated;
