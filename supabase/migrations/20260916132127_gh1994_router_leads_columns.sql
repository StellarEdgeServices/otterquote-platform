-- gh-1994: front-door router page (phase 1) -- additive `leads` columns
-- plus two SECURITY DEFINER RPCs. Requested-by exec:cro (Sloane, CRO RUN 24,
-- claim cro-2026-09-16T11:19:36Z); filed as issue #1994; Dustin's verbatim
-- 2026-09-16 spec is quoted in full on the issue body. Tier 3A additive:
-- nullable columns + two new functions only. No existing column, policy,
-- trigger or function is altered or dropped.
--
-- NOT APPLIED BY THIS PR. `apply_migration` has not been called -- this is a
-- migration FILE only, proposed for review, per the phase-1 rails for #1994
-- (CEO RUN 48 dispatch, claim ceo-2026-09-16T13:09:26Z). A claim-holder
-- applies it in daylight after R-177 LEGAL-READ and CTO review.
--
-- Schema verified LIVE (production yeszghaspzwwstvsrioa) before drafting
-- this file, 2026-09-16T13:1x:xxZ:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='leads'
--    ORDER BY ordinal_position;
--   -> exactly {id, email, name, zip, source, created_at} -- byte-for-byte
--   match with supabase/migrations/20260101000000_v000_baseline_schema.sql
--   lines 644-651. No drift; no migration between baseline and this one
--   touches public.leads except 20260908111639_gh1529 (grants only, and per
--   that file's own text NOT APPLIED for the leads/anon-INSERT pair).
--
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--    WHERE schemaname='public' AND tablename='leads';
--   -> "Allow anonymous inserts" (INSERT, {anon}, with_check=true) and
--      "Allow authenticated reads" (SELECT, {authenticated}, qual=true).
--   No anon UPDATE and no anon SELECT policy exists -- hence the two RPCs
--   below rather than a direct client UPDATE/SELECT from the router or the
--   destination pages.
--
-- Insert path (unchanged by this migration): Step 1's direct
-- `sb.from('leads').insert(...)` reuses the existing "Allow anonymous
-- inserts" policy already exercised today by partner-re.html:1461
-- (`sb.from('leads').insert({ name, email, source: 're_agent', created_at })`).
-- This migration adds no new INSERT policy and no insert RPC.

BEGIN;

-- 1. Columns -------------------------------------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS phone              text,
  ADD COLUMN IF NOT EXISTS role               text,
  ADD COLUMN IF NOT EXISTS partner_industry   text,
  ADD COLUMN IF NOT EXISTS utm_source         text,
  ADD COLUMN IF NOT EXISTS utm_medium         text,
  ADD COLUMN IF NOT EXISTS utm_campaign       text,
  ADD COLUMN IF NOT EXISTS utm_content        text,
  ADD COLUMN IF NOT EXISTS utm_term           text,
  ADD COLUMN IF NOT EXISTS fbclid             text,
  ADD COLUMN IF NOT EXISTS gclid              text,
  ADD COLUMN IF NOT EXISTS converted_user_id  uuid;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_role_check
    CHECK (role IS NULL OR role IN ('homeowner', 'contractor', 'referral_partner'));

-- partner_industry values mirror the five CHOOSER_LABELS keys in
-- js/agent-types.js (gh-914 single source for the partner-page industry
-- set), which itself is drawn from the six-value
-- referral_agents_agent_type_check CHECK constraint
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql) minus
-- 'customer' -- CHOOSER_LABELS omits 'customer' for the same reason this
-- column does: a router visitor who answers "Referral partner" at Step 2
-- always reaches Step 2a and picks one of the five partner industries, they
-- never self-select the recruit.html-only "I'm a homeowner referring a
-- friend" answer.
ALTER TABLE public.leads
  ADD CONSTRAINT leads_partner_industry_check
    CHECK (partner_industry IS NULL OR partner_industry IN
      ('re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'));

-- Same FK pattern as claims.user_id / contractors.user_id
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql:3819,3826).
-- ON DELETE SET NULL, not CASCADE: a lead is marketing/attribution history
-- and should survive the account it converted to being deleted.
ALTER TABLE public.leads
  ADD CONSTRAINT leads_converted_user_id_fkey
    FOREIGN KEY (converted_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.leads.phone IS
  'gh-1994: router Step 1, required 10-digit US number, validated client-side only (no server-side format check in phase 1).';
COMMENT ON COLUMN public.leads.role IS
  'gh-1994: router Step 2 answer (homeowner/contractor/referral_partner). NULL until Step 2 completes -- set post-insert via set_lead_role() because leads has no anon UPDATE policy.';
COMMENT ON COLUMN public.leads.partner_industry IS
  'gh-1994: router Step 2a answer, set only when role=referral_partner. Set via set_lead_role(), same call as role.';
COMMENT ON COLUMN public.leads.utm_source IS
  'gh-1994: captured from the router landing URL, with the oq_ft cookie (gh-1983, js cookie name FT_COOKIE) as fallback, at the Step 1 insert.';
COMMENT ON COLUMN public.leads.fbclid IS
  'gh-1994: see utm_source comment. No length cap enforced at the DB layer in phase 1 (client truncates before insert, mirroring attribution-core.ts CLICK_ID_MAX=1000).';
COMMENT ON COLUMN public.leads.converted_user_id IS
  'gh-1994: reserved for a future backfill linking this lead to the auth.users row it became, if any. Not written anywhere in phase 1.';

-- 2. Prefill RPC -----------------------------------------------------------
-- Returns name/email/phone for a lead row created within the last 60
-- minutes, keyed by the opaque lead id only -- so the router's Step 3
-- redirect can pass `?lead=<uuid>` instead of email/phone/name in the query
-- string (#1931: GA4, Clarity and the Meta pixel all record full URLs).
-- SECURITY DEFINER because leads has no anon SELECT policy (only
-- "Allow authenticated reads" above, confirmed live), and the destination
-- pages (contractor-join.html, partner-re/insurance/inspectors/adjusters/
-- other.html) run fully anonymous at this point in the funnel.
CREATE OR REPLACE FUNCTION public.get_lead_prefill(p_lead_id uuid)
RETURNS TABLE(name text, email text, phone text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT l.name, l.email, l.phone
    FROM public.leads l
   WHERE l.id = p_lead_id
     AND l.created_at > now() - interval '60 minutes';
$$;

-- Project default privileges grant EXECUTE on new public functions to anon
-- and authenticated explicitly (see gh-1983's gh1983_attr_clean() comment,
-- same file), so REVOKE ... FROM PUBLIC alone would not remove it.
REVOKE ALL ON FUNCTION public.get_lead_prefill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_lead_prefill(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_lead_prefill(uuid) IS
  'gh-1994: SECURITY DEFINER prefill lookup for the router''s ?lead=<uuid> redirect. Returns zero rows once 60 minutes have passed since the lead was created, or for any id that never matched a row -- callers must treat an empty result as "no prefill available", never as an error.';

-- 3. Role/industry RPC -------------------------------------------------------
-- Sets role (and partner_industry, for referral_partner only) on a lead row
-- created within the last 60 minutes. Mirrors the register_partner() /
-- record_first_touch_attribution() precedent already in this repo: a
-- SECURITY DEFINER RPC is how this codebase lets an anonymous client write a
-- column no anon RLS policy exposes directly, rather than widening leads'
-- RLS or table grants.
CREATE OR REPLACE FUNCTION public.set_lead_role(
  p_lead_id uuid,
  p_role text,
  p_partner_industry text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_role NOT IN ('homeowner', 'contractor', 'referral_partner') THEN
    RAISE EXCEPTION 'set_lead_role: invalid role %', p_role;
  END IF;

  IF p_role = 'referral_partner' AND p_partner_industry IS NOT NULL
     AND p_partner_industry NOT IN
       ('re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other') THEN
    RAISE EXCEPTION 'set_lead_role: invalid partner_industry %', p_partner_industry;
  END IF;

  UPDATE public.leads
     SET role             = p_role,
         partner_industry = CASE WHEN p_role = 'referral_partner' THEN p_partner_industry ELSE NULL END
   WHERE id = p_lead_id
     AND created_at > now() - interval '60 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.set_lead_role(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_role(uuid, text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.set_lead_role(uuid, text, text) IS
  'gh-1994: SECURITY DEFINER role/industry write for the router''s Step 2/2a, called by an anon client (leads has no anon UPDATE policy). Silently no-ops (0 rows updated, no error) past the 60-minute window or for an id that never matched -- callers must not depend on an error to detect that case.';

COMMIT;

-- ROLLBACK (manual -- this migration is not applied, and phase 1 was not
-- granted a separate supabase/migrations_rollbacks/ file; inline per the
-- lighter convention already used by
-- supabase/migrations/20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql):
--
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.set_lead_role(uuid, text, text);
-- DROP FUNCTION IF EXISTS public.get_lead_prefill(uuid);
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_converted_user_id_fkey;
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_partner_industry_check;
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_role_check;
-- ALTER TABLE public.leads
--   DROP COLUMN IF EXISTS converted_user_id,
--   DROP COLUMN IF EXISTS gclid,
--   DROP COLUMN IF EXISTS fbclid,
--   DROP COLUMN IF EXISTS utm_term,
--   DROP COLUMN IF EXISTS utm_content,
--   DROP COLUMN IF EXISTS utm_campaign,
--   DROP COLUMN IF EXISTS utm_medium,
--   DROP COLUMN IF EXISTS utm_source,
--   DROP COLUMN IF EXISTS partner_industry,
--   DROP COLUMN IF EXISTS role,
--   DROP COLUMN IF EXISTS phone;
-- COMMIT;
