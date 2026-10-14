-- STATUS (gh-1438, as of 2026-10-14T07:22Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2431_profiles_address_state_backfill (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2431 (CTO RUN 65); proved in supabase/tests/gh2431_address_state_backfill_proof.sql
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2431 ROLLBACK for supabase/migrations_drafts/gh2431_profiles_address_state_backfill.sql
-- Manual reference only. Never rename into a 14-digit timestamp or move into supabase/migrations/.
-- Restores 'IN' on exactly the profiles the forward file cleared (via its audit table), only where the
-- state is still NULL (a state the homeowner entered since is kept), then drops the audit table.

BEGIN;

UPDATE public.profiles p
   SET address_state = a.prior_state
  FROM public.gh2431_profiles_state_backfill_audit a
 WHERE a.profile_id = p.id
   AND p.address_state IS NULL;

DROP TABLE public.gh2431_profiles_state_backfill_audit;

COMMIT;
