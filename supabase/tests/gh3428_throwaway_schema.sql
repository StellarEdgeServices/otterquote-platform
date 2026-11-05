-- gh-3428 throwaway schema: the minimum of production the owner-alert sweep touches. Throwaway Postgres only. Column names are the repo's baseline
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql and the hover_orders columns create-measurement-order writes). Pre-existing rows exist BEFORE the forward file runs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
-- Supabase default privileges: new public functions are executable by anon and authenticated (danger pattern 9). Reproduce it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, is_test boolean DEFAULT false NOT NULL);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text, ready_for_bids boolean DEFAULT false,
  property_state text, is_test boolean DEFAULT false, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
CREATE TABLE public.hover_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, user_id uuid NOT NULL, status text, product_code text,
  requested_by_role text, requested_by_contractor_id uuid, homeowner_stripe_payment_intent_id text, created_at timestamptz DEFAULT now());
-- Production's public.is_internal_test_email (20261003014844_gh2310_gap2...): same shape, the two staff gmail bases fixed here.
CREATE FUNCTION public.is_internal_test_email(p_email text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_email IS NULL THEN false ELSE
    split_part(lower(btrim(p_email)),'@',2) IN ('stellaredgeservices.com','tryotterquote.com','stohlerroof.com','otterquote-internal.test')
    OR (split_part(lower(btrim(p_email)),'@',2)='gmail.com' AND split_part(split_part(lower(btrim(p_email)),'@',1),'+',1) IN ('dustinstohler1','staffbase2'))
  END $$;
REVOKE ALL ON FUNCTION public.is_internal_test_email(text) FROM PUBLIC, anon, authenticated;

-- pg_cron / pg_net / vault stand-ins so the cron file can be executed and its stored command read back.
CREATE SCHEMA cron; CREATE SCHEMA net; CREATE SCHEMA vault;
CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname,schedule,command) VALUES (p_name,p_schedule,p_command)
  ON CONFLICT (jobname) DO UPDATE SET schedule=EXCLUDED.schedule, command=EXCLUDED.command RETURNING jobid::bigint $$;
CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS $$ WITH d AS (DELETE FROM cron.job WHERE jobname=p_name RETURNING 1) SELECT count(*)>0 FROM d $$;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);

-- Pre-existing production-shaped data (BEFORE the forward file): these must become 'baseline' and never ring.
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-0000000000a1','real.owner@example.com',false),
  ('00000000-0000-0000-0000-0000000000a2','flagged.test@example.com',true),
  ('00000000-0000-0000-0000-0000000000a3','unflagged.staff@stellaredgeservices.com',false),
  ('00000000-0000-0000-0000-0000000000a4','dustinstohler1+walk@gmail.com',false),
  ('00000000-0000-0000-0000-0000000000a5','late.signup@otterquote.com',false),
  ('00000000-0000-0000-0000-0000000000a6','real.buyer@example.com',false);
INSERT INTO public.claims (id,user_id,status,ready_for_bids,property_state,is_test) VALUES
  ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-0000000000a1','active',true,'IN',false);   -- ready BEFORE install
INSERT INTO public.hover_orders (id,claim_id,user_id,status,product_code,requested_by_role,homeowner_stripe_payment_intent_id) VALUES
  ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-0000000000a1','awaiting_fulfillment','roof_basic','homeowner','pi_pre_existing');
