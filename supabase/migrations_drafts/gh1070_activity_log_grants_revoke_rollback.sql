-- Rollback: gh1070_activity_log_grants_revoke_rollback.sql
-- Reverts: gh1070_activity_log_grants_revoke.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #1070
--
-- Restores the exact pre-migration grant set and INSERT policy check,
-- verified against the live definitions read this session (2026-08-21),
-- not reconstructed from memory. No guard/abort condition is needed here
-- (unlike gh1021's paid-row guard) — re-granting privileges and loosening
-- a with_check clause back to its original form cannot destroy data or
-- violate a narrower constraint against existing rows.

BEGIN;

-- Restore original with_check (drops the is_test = false requirement added
-- by the forward migration).
ALTER POLICY "Users can insert own activity" ON public.activity_log
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- Restore anon's original full grant set (live-verified pre-migration state).
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log TO anon;

-- Restore authenticated's original full grant set (SELECT and INSERT were
-- never revoked by the forward migration; this re-adds the other five).
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log TO authenticated;

COMMIT;
