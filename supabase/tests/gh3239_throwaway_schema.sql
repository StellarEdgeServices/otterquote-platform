-- gh-3239: THROWAWAY schema for supabase/tests/gh3239_partner_agreement_v4_proof.sql. Scratch Postgres 16 only; never apply anywhere else.
-- Models production (read-only 2026-10-30) as far as gh3239 touches it:
--   - roles anon / authenticated / service_role and production's auth.uid()/role()/jwt() (they read request.jwt.claims);
--   - public.referral_agents with production's full column list, RLS on, production's four non-admin policies, its table grants
--     (anon SELECT; authenticated SELECT + UPDATE), and production's two BEFORE UPDATE guards, referral_agents_guard_payout_columns()
--     and referral_agents_guard_agent_type() (function bodies copied from pg_get_functiondef, comments trimmed);
--   - register_partner(21 args): NOT copied here. The runner extracts it from
--     supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql lines 318-622, whose body md5 equals production's
--     (042da30fdc75423c32383035b27f2fa4); the proof asserts that md5 in the BASELINE phase.
-- Stubs (not production code): check_rate_limit() always allows, rate_limit_client_key() hashes the IP, is_test_email() matches
--   @example.test, is_admin_email() matches admin@example.test, and unique_code / recruit_code come from a simple BEFORE INSERT trigger.
\set ON_ERROR_STOP on
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

-- stubs ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.check_rate_limit(p_function_name text, p_user_id uuid) RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{"allowed": true}'::jsonb $f$;
CREATE FUNCTION public.rate_limit_client_key(p_ip text) RETURNS uuid LANGUAGE sql AS $f$ SELECT CASE WHEN p_ip IS NULL THEN NULL ELSE md5(p_ip)::uuid END $f$;
CREATE FUNCTION public.is_test_email(p_email text) RETURNS boolean LANGUAGE sql AS $f$ SELECT COALESCE(p_email, '') LIKE '%@example.test' $f$;
CREATE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT COALESCE(auth.jwt() ->> 'email', '') = 'admin@example.test' $f$;

CREATE TABLE public.referral_agents (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  agent_type text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL CONSTRAINT referral_agents_email_key UNIQUE,
  phone text,
  company text,
  photo_url text,
  bio text,
  website text,
  service_area text,
  unique_code text NOT NULL CONSTRAINT referral_agents_unique_code_key UNIQUE,
  status text DEFAULT 'active'::text NOT NULL,
  onboarded_at timestamp with time zone,
  total_referrals integer DEFAULT 0,
  total_commission_earned numeric DEFAULT 0,
  total_commission_paid numeric DEFAULT 0,
  user_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  recruit_code text CONSTRAINT referral_agents_recruit_code_key UNIQUE,
  recruited_by_id uuid,
  recruited_at timestamp with time zone,
  recruit_earnings numeric DEFAULT 0,
  referred_by_note text,
  w9_file_url text,
  w9_submitted_at timestamp with time zone,
  w9_verified_at timestamp with time zone,
  payments_blocked boolean DEFAULT true NOT NULL,
  w9_notification_sent_at timestamp with time zone,
  public_directory_optin boolean DEFAULT false NOT NULL,
  is_test boolean DEFAULT false NOT NULL,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  partner_agreement_version text,
  partner_agreement_accepted_at timestamp with time zone,
  partner_agreement_attestation jsonb DEFAULT '{}'::jsonb NOT NULL,
  needs_partner_reacceptance boolean DEFAULT false NOT NULL,
  fbclid text,
  li_fat_id text,
  funnel_id text,
  app_first_signed_in_launch_at timestamp with time zone,
  onboarding_opted_out_at timestamp with time zone,
  meta_lead_id text CONSTRAINT referral_agents_meta_lead_id_key UNIQUE
);

CREATE FUNCTION public.stub_referral_codes() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  NEW.unique_code  := COALESCE(NEW.unique_code, substr(md5(random()::text), 1, 10));
  NEW.recruit_code := COALESCE(NEW.recruit_code, substr(md5(random()::text), 1, 10));
  RETURN NEW;
END $f$;
CREATE TRIGGER referral_agents_generate_code BEFORE INSERT ON public.referral_agents FOR EACH ROW EXECUTE FUNCTION public.stub_referral_codes();

-- production guards (bodies from pg_get_functiondef 2026-10-30, comments trimmed) ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.referral_agents_guard_payout_columns()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if is_admin_email() then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    new.payments_blocked           := true;
    new.w9_verified_at             := null;
    new.w9_file_url                := null;
    new.w9_submitted_at            := null;
    new.total_commission_earned    := 0;
    new.total_commission_paid      := 0;
    new.recruit_earnings           := 0;
    return new;
  end if;
  if coalesce(
       (new.fbclid    is distinct from old.fbclid)
       or (new.li_fat_id is distinct from old.li_fat_id)
       or (new.funnel_id is distinct from old.funnel_id)
       or (new.meta_lead_id is distinct from old.meta_lead_id)
       or (
         (new.app_first_signed_in_launch_at is distinct from old.app_first_signed_in_launch_at)
         and not (
           coalesce(current_setting('oq.gh2154_activation_write', true), '') = '1'
           and old.app_first_signed_in_launch_at is null
           and new.app_first_signed_in_launch_at is not null
         )
       ),
       true
     )
  then
    raise exception
      'referral_agents: attribution/activation columns can only be changed by service_role, an admin, or record_partner_app_activation() (gh-2154)'
      using errcode = '42501';
  end if;
  if (new.payments_blocked           is distinct from old.payments_blocked)
     or (new.w9_verified_at          is distinct from old.w9_verified_at)
     or (new.w9_file_url             is distinct from old.w9_file_url)
     or (new.w9_submitted_at         is distinct from old.w9_submitted_at)
     or (new.recruited_at            is distinct from old.recruited_at)
     or (new.recruited_by_id         is distinct from old.recruited_by_id)
     or (new.total_commission_earned is distinct from old.total_commission_earned)
     or (new.total_commission_paid   is distinct from old.total_commission_paid)
     or (new.recruit_earnings        is distinct from old.recruit_earnings)
     or (new.status                  is distinct from old.status)
     or (new.is_test                 is distinct from old.is_test)
  then
    raise exception
      'referral_agents: payout-governing columns can only be changed by service_role or an admin (gh-886)'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
CREATE TRIGGER referral_agents_guard_payout_columns BEFORE INSERT OR UPDATE ON public.referral_agents FOR EACH ROW EXECUTE FUNCTION public.referral_agents_guard_payout_columns();

CREATE OR REPLACE FUNCTION public.referral_agents_guard_agent_type()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND COALESCE(NEW.agent_type IS DISTINCT FROM OLD.agent_type, true) THEN
    RAISE EXCEPTION 'referral_agents: agent_type can only be changed by service_role or an admin (gh-2479)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER referral_agents_guard_agent_type BEFORE UPDATE ON public.referral_agents FOR EACH ROW EXECUTE FUNCTION public.referral_agents_guard_agent_type();

-- RLS, policies and grants as production -------------------------------------------------------------------------------------------------
ALTER TABLE public.referral_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin can read all referral agents" ON public.referral_agents FOR SELECT USING (is_admin_email());
CREATE POLICY "Admin can update referral agents" ON public.referral_agents FOR UPDATE USING (is_admin_email()) WITH CHECK (is_admin_email());
CREATE POLICY "Agents can update own profile" ON public.referral_agents FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Agents can view own profile" ON public.referral_agents FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Service role full access" ON public.referral_agents USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
GRANT SELECT ON public.referral_agents TO anon;
GRANT SELECT, UPDATE ON public.referral_agents TO authenticated;
GRANT ALL ON public.referral_agents TO service_role;
