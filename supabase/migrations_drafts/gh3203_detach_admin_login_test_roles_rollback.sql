-- STATUS (gh-3203, 2026-11-11): NOT APPLIED. tier:3b. DRAFT ONLY. Rollback of gh3203_detach_admin_login_test_roles.sql.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Restores the pre-state read in #3203 comment 6508428206 (contractor pending_approval, agent active, profile role contractor).
BEGIN;
UPDATE public.contractors SET status = 'pending_approval', user_id = '3ea4d929-b916-4cc9-a285-d052df397992'
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id IS NULL;
UPDATE public.referral_agents SET status = 'active'
 WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND status = 'suspended';
UPDATE public.profiles SET role = 'contractor'
 WHERE id = '3ea4d929-b916-4cc9-a285-d052df397992' AND role = 'homeowner';
COMMIT;
