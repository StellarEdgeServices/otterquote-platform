-- LOCAL-ONLY additions to local_pg16/00_stub_schema.sql for the gh-3219 proof run (throwaway Postgres, never production).
-- Columns/tables the gh-3219 functions and proof touch that the base stub lacks.
ALTER TABLE public.referrals ADD COLUMN homeowner_email text;
ALTER TABLE public.referrals ALTER COLUMN status SET DEFAULT 'clicked';
ALTER TABLE public.claims ADD COLUMN referral_agent_id uuid;
CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
CREATE TABLE auth.users (id uuid PRIMARY KEY);
-- update_referral_stats() is a no-op stand-in (production keeps agent counters; irrelevant here)
CREATE FUNCTION public.update_referral_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER referrals_update_stats AFTER UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION public.update_referral_stats();
-- fixtures: 6+ test users, 2+ test agents (the proof picks the first ones by id)
INSERT INTO auth.users(id) SELECT gen_random_uuid() FROM generate_series(1,14);
INSERT INTO public.profiles(id, is_test) SELECT id, true FROM auth.users;
INSERT INTO public.referral_agents(agent_type, is_test, first_name, last_name) VALUES ('realtor', true, 'A', 'Test'), ('influencer', true, 'B', 'Test'), ('realtor', true, 'C', 'Test');
