-- LOCAL-ONLY additions to local_pg16/00_stub_schema.sql for the gh-3219 proof run (throwaway Postgres, never production).
-- Columns/tables the gh-3219 functions and proof touch that the base stub lacks.
ALTER TABLE public.referrals ADD COLUMN homeowner_email text;
ALTER TABLE public.referrals ALTER COLUMN status SET DEFAULT 'clicked';
ALTER TABLE public.claims ADD COLUMN referral_agent_id uuid;
CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
CREATE TABLE auth.users (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
-- update_referral_stats() is a no-op stand-in (production keeps agent counters; irrelevant here)
CREATE FUNCTION public.update_referral_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER referrals_update_stats AFTER UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION public.update_referral_stats();
-- fixtures: 6+ test users, 2+ test agents (the proof picks the first ones by id)
INSERT INTO auth.users(id) SELECT gen_random_uuid() FROM generate_series(1,22);
INSERT INTO public.profiles(id, is_test) SELECT id, true FROM auth.users;
INSERT INTO public.referral_agents(agent_type, is_test, first_name, last_name) VALUES ('realtor', true, 'A', 'Test'), ('influencer', true, 'B', 'Test'), ('realtor', true, 'C', 'Test');
-- PR #3225 part B simulated: table-level SELECT revoked from anon/authenticated, re-granted on an explicit column allow-list
-- (homeowner_user_id is NOT on it). Without this the gh-3219 forward file refuses to run (its fail-closed guard).
REVOKE SELECT ON public.referrals FROM anon, authenticated;
GRANT SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount) ON public.referrals TO anon, authenticated;
