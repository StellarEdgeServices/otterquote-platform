-- STATUS (gh-3203, 2026-11-11): NOT APPLIED. tier:3b. DRAFT ONLY. Never applied by an agent.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Refs #3203. Pair: gh3203_detach_admin_login_test_roles_rollback.sql
-- APPLY GATE (all required): (1) gh2479 proof passed on production against partner 56c1319a (#3203 comment 6687879598 says
--   the production run is a separate grant, not yet run); (2) Dustin's word to apply (Tier 3B); (3) the R-097 24 h notice
--   (6508440952) already ran its window, re-confirm no objection.
-- WHAT IT DOES (test data only, archive never delete, constitution entry 30):
--   login dustinstohler1@gmail.com = auth user 3ea4d929-b916-4cc9-a285-d052df397992
--   a) contractors ee452a12-c16e-4d30-9d2c-df8128fbce52 ("Stohler Roofing, LLC", pending_approval, is_test):
--      status -> 'inactive' AND user_id -> NULL. user_id NULL is REQUIRED: public.resolved_user_role.is_contractor is
--      EXISTS(contractors row for the user) with NO status filter (migrations/20260819224215_v113_derived_role_view.sql),
--      so a status change alone would leave derived_role = 'contractor'. contractors.user_id is nullable (baseline).
--   b) referral_agents 1927861f-8836-49ce-a528-08c432cc69cc: status 'active' -> 'suspended'. The CHECK allows only
--      pending/active/suspended (baseline referral_agents_status_check), NOT 'inactive' as #3203 6508428206 proposed. The view
--      only counts status='active', so 'suspended' removes the partner role.
--   c) profiles 3ea4d929: role 'contractor' -> 'homeowner' (CHECK allows homeowner/contractor only; admin power = is_admin_email()).
-- Pre-state (read 2026-10-29, comment 6508428206): re-read before applying; the guards below abort if it has drifted.
BEGIN;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.contractors
   WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: contractor ee452a12 not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.referral_agents
   WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: agent 1927861f not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.claims WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992'
     OR selected_contractor_id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 guard: % claims reference the login/contractor; stop and ask', n; END IF;
END $$;

UPDATE public.contractors SET status = 'inactive', user_id = NULL
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992';

UPDATE public.referral_agents SET status = 'suspended'
 WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND status = 'active';

UPDATE public.profiles SET role = 'homeowner'
 WHERE id = '3ea4d929-b916-4cc9-a285-d052df397992' AND role = 'contractor';

-- Post-check inside the transaction: the derived-role facts for this user must now be empty.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.contractors WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 post-check: login still owns % contractors rows', n; END IF;
  SELECT count(*) INTO n FROM public.referral_agents WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND status = 'active';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 post-check: login still has % active agent rows', n; END IF;
END $$;

COMMIT;
