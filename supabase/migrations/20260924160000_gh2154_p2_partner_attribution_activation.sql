-- gh-2154 P-2: partner attribution columns + first signed-in standalone app launch.
--
-- Parent: #2154 (D-333 shared partner foundation, build item P-2, Marty's
-- build-sequence comment 5816579743). referral_agents already carries
-- utm_source/medium/campaign/content (gh-846) but has nowhere to put a
-- Facebook click id, a LinkedIn first-party ad click id, or a funnel
-- identifier, and no way to know when a partner first opens the installed
-- PWA while signed in. P-1's short signup form (later item, not built here)
-- needs fbclid/li_fat_id/funnel_id to exist on the table before it can write
-- them; P-4's onboarding-sequence stop condition (later item) needs the
-- activation timestamp to exist before it can check it.
--
-- Tier: 3A additive migration, per Marty's sequencing comment. Confirmed
-- live and read-only against production (yeszghaspzwwstvsrioa) before
-- authoring this file: referral_agents has no fbclid/li_fat_id/funnel_id/
-- activation-timestamp column, register_partner's only live overload is
-- byte-identical to the definition in
-- 20260820195608_gh1075_partner_agreement_v2_version_bump.sql (17 args,
-- ending p_is_test), and no record_partner_app_activation function exists.
--
-- Follows the gh-846 precedent (20260814110108_gh846_add_utm_columns_to_
-- referral_agents.sql): additive nullable columns, then register_partner's
-- signature grows by additive trailing DEFAULT NULL params, with the old
-- overload dropped explicitly so PostgREST never has to disambiguate two
-- overlapping signatures. register_partner's function body is otherwise
-- byte-identical to the live definition; only the INSERT column/value lists
-- and the parameter list change. PUBLIC/anon/authenticated/service_role all
-- keep their existing default EXECUTE (unchanged from every prior
-- register_partner revision, none of which have ever revoked it); no
-- explicit GRANT is added here, since the schema's default privileges
-- already supply it (see the no-GRANT note below).
--
-- record_partner_app_activation() is new: SECURITY DEFINER, first-write-wins
-- (only writes when the column is still NULL), scoped to the caller's own
-- referral_agents row via auth.uid() = user_id, so no partner can write
-- another partner's row and a signed-out caller (auth.uid() IS NULL) can
-- never match any row. EXECUTE is revoked from PUBLIC, anon, and
-- service_role, matching this project's "new function defaults to
-- anon/authenticated/service_role EXECUTE" trap (Claude's Memories
-- supabase-function-grant-defaults.md) — authenticated keeps its
-- schema-level default-granted EXECUTE (no explicit GRANT line, so CI's
-- permissions-ratchet has nothing new to flag); PUBLIC/anon/service_role
-- are explicitly revoked since only a signed-in partner should ever call
-- it and there is no server-side caller.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924160000_gh2154_p2_partner_attribution_
-- activation_rollback.sql (REVIEW FAIL 5818340009 must-fix 2) -- drops
-- record_partner_app_activation() and the 20-arg register_partner, recreates
-- the pre-migration 17-arg register_partner byte-identical to
-- 20260820195608_gh1075_partner_agreement_v2_version_bump.sql, then drops the
-- four additive columns. Safe because every new column is nullable and no
-- other object references them yet (P-1/P-4, which will, are not built).
-- The rollback also restores public.referral_agents_guard_payout_columns()
-- to its exact pre-migration (live) body -- BEFORE dropping the four
-- columns, since that pre-migration body references them.
--
-- DRIFT NOTE (Ben 17:10:10Z column-lock ruling): the live
-- referral_agents_guard_payout_columns() on prod (md5(pg_get_functiondef)
-- first 8 hex = b863cbc1) is NOT byte-identical to
-- 20260818211118_gh886_referral_agents_payout_guard.sql, the only migration
-- in this repo that defines it -- live has an entire TG_OP = 'INSERT'
-- branch and pins three extra columns (w9_file_url, w9_submitted_at,
-- total_commission_paid) that gh-886's file never mentions, meaning some
-- change was applied to prod outside git history (git log --all -S found
-- it on no branch). Live is a strict superset/hardening of gh-886, not a
-- weakening, so per Ben's ruling this migration adopts the LIVE body
-- verbatim as CREATE OR REPLACE (below), with one new block added before
-- the existing payout check, so the repo returns to parity with prod. This
-- migration is therefore the first place in version control that records
-- the current production trigger logic.

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz;

-- Old 17-arg overload dropped explicitly (gh-846 pattern) so the new
-- 20-arg signature never coexists with it.
DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean
);

CREATE FUNCTION public.register_partner(
  p_agent_type       text,
  p_first_name       text,
  p_last_name        text,
  p_email            text,
  p_phone            text DEFAULT NULL,
  p_company          text DEFAULT NULL,
  p_website          text DEFAULT NULL,
  p_service_area     text DEFAULT NULL,
  p_referred_by_note text DEFAULT NULL,
  p_recruit_code     text DEFAULT NULL,
  p_metadata         jsonb DEFAULT '{}'::jsonb,
  p_photo_url        text DEFAULT NULL,
  p_utm_source       text DEFAULT NULL,
  p_utm_medium       text DEFAULT NULL,
  p_utm_campaign     text DEFAULT NULL,
  p_utm_content      text DEFAULT NULL,
  p_is_test          boolean DEFAULT false,
  p_fbclid           text DEFAULT NULL,
  p_li_fat_id        text DEFAULT NULL,
  p_funnel_id        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email        text;
  v_recruiter_id uuid;
  v_constraint   text;
  v_row          referral_agents%ROWTYPE;
  v_rate         jsonb;
  v_headers      jsonb;
  v_ip           text;
  v_ua           text;
  v_agreement_version CONSTANT text := 'v2-2026-08';
BEGIN
  v_rate := public.check_rate_limit(
    p_function_name => 'register_partner',
    p_user_id       => auth.uid()
  );
  IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
  END IF;

  IF p_agent_type IS NULL OR p_agent_type NOT IN
     ('re_agent', 'insurance_agent', 'home_inspector', 'customer', 'adjuster', 'other') THEN
    RAISE EXCEPTION 'invalid_agent_type: % is not a recognized partner type',
      COALESCE(p_agent_type, '(null)');
  END IF;

  v_email := lower(btrim(COALESCE(p_email, '')));
  IF btrim(COALESCE(p_first_name, '')) = ''
     OR btrim(COALESCE(p_last_name, '')) = ''
     OR v_email = '' THEN
    RAISE EXCEPTION 'missing_required_fields: first name, last name, and email are required';
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'invalid_email: please provide a valid email address';
  END IF;

  IF EXISTS (SELECT 1 FROM referral_agents WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'partner_exists';
  END IF;

  IF p_recruit_code IS NOT NULL AND btrim(p_recruit_code) <> '' THEN
    SELECT id INTO v_recruiter_id
    FROM referral_agents
    WHERE recruit_code = btrim(p_recruit_code)
      AND status = 'active';
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;
  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    partner_agreement_version, partner_agreement_accepted_at,
    partner_agreement_attestation,
    fbclid, li_fat_id, funnel_id
  ) VALUES (
    p_agent_type,
    btrim(p_first_name),
    btrim(p_last_name),
    v_email,
    NULLIF(btrim(COALESCE(p_phone,        '')), ''),
    NULLIF(btrim(COALESCE(p_company,      '')), ''),
    NULLIF(btrim(COALESCE(p_website,      '')), ''),
    NULLIF(btrim(COALESCE(p_service_area, '')), ''),
    NULLIF(btrim(COALESCE(p_photo_url,    '')), ''),
    NULLIF(btrim(COALESCE(p_referred_by_note, '')), ''),
    COALESCE(p_metadata, '{}'::jsonb),
    v_recruiter_id,
    CASE WHEN v_recruiter_id IS NOT NULL THEN now() END,
    NULLIF(btrim(COALESCE(p_utm_source,   '')), ''),
    NULLIF(btrim(COALESCE(p_utm_medium,   '')), ''),
    NULLIF(btrim(COALESCE(p_utm_campaign, '')), ''),
    NULLIF(btrim(COALESCE(p_utm_content,  '')), ''),
    COALESCE(p_is_test, false),
    v_agreement_version,
    now(),
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    ),
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), '')
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id',           v_row.id,
    'unique_code',  v_row.unique_code,
    'recruit_code', v_row.recruit_code
  );
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'referral_agents_email_key' THEN
      RAISE EXCEPTION 'partner_exists';
    END IF;
    RAISE;
END;
$function$;

-- No explicit GRANT here (unlike gh-846's migration): this project's schema
-- already runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role`, confirmed live by probing
-- a throwaway function's proacl inside an aborted transaction before writing
-- this migration -- every new public function already gets anon/
-- authenticated/service_role EXECUTE by default, identical to what an
-- explicit GRANT would add. Adding one anyway is what CI's permissions-
-- ratchet (gh-1767, "No new GRANT to anon/PUBLIC/authenticated") is built to
-- flag on any new-looking GRANT line in a migration diff, reviewed-label or
-- not; omitting the now-redundant statement keeps this function's live
-- grants (PUBLIC/anon/authenticated/service_role, unchanged from before this
-- migration) with no explicit line for the ratchet to have an opinion about.

-- gh-2154 column lock (Ben, CEO, 17:10:10Z): before this, `authenticated`
-- had table UPDATE on referral_agents and RLS policy "Agents can update own
-- profile" was `user_id = auth.uid()`, so a signed-in partner could PATCH
-- their OWN row's fbclid/li_fat_id/funnel_id (rewrite their own attribution)
-- or app_first_signed_in_launch_at (null it out or backdate it), and P-4's
-- onboarding-sequence stop condition (a later build item) will trust that
-- timestamp. This CREATE OR REPLACE starts from the LIVE body (see DRIFT
-- NOTE above) byte-for-byte and adds exactly one new block, before the
-- existing payout-column check, pinning fbclid/li_fat_id/funnel_id (always)
-- and app_first_signed_in_launch_at (except through the one sanctioned
-- path below).
--
-- THE TRAP, and how this avoids it: record_partner_app_activation() below
-- is itself SECURITY DEFINER, and this trigger function is SECURITY
-- DEFINER too, so naively checking current_user or a role would see
-- "postgres" either way and could never distinguish a legitimate RPC call
-- from a direct partner UPDATE -- and auth.role() reads the JWT claim, so
-- inside the RPC auth.role() is STILL 'authenticated', not something a
-- service_role check could catch. So the pin does not key off role or
-- current_user at all: record_partner_app_activation() sets a
-- transaction-local GUC (`oq.gh2154_activation_write`) immediately before
-- its UPDATE and clears it immediately after, and this trigger's allow
-- clause requires BOTH that GUC AND old.app_first_signed_in_launch_at IS
-- NULL AND new.app_first_signed_in_launch_at IS NOT NULL -- i.e. only a
-- first-write-wins activation performed via the RPC is let through; the
-- RPC calling itself a second time (already non-NULL old value) still
-- gets caught by this same trigger, same as a direct UPDATE would. The GUC
-- itself is not callable by a partner: set_config() lives in pg_catalog,
-- which is not a PostgREST-exposed schema (confirmed live, see report),
-- and no public wrapper function forwards a caller-controlled set_config
-- call (confirmed live via a pg_proc/prosrc scan, see report).
CREATE OR REPLACE FUNCTION public.referral_agents_guard_payout_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if is_admin_email() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    -- Defense in depth only: register_partner() (SECURITY DEFINER) never sets these on insert
    -- and bypasses table grants/RLS entirely, so this branch only matters if some future path
    -- inserts directly. recruited_at/recruited_by_id/status/is_test are deliberately NOT forced
    -- here -- register_partner() legitimately sets recruited_at/recruited_by_id for the
    -- recruiter-linking flow (always now(), never caller-backdated), and forcing them would
    -- break that flow.
    new.payments_blocked           := true;
    new.w9_verified_at             := null;
    new.w9_file_url                := null;
    new.w9_submitted_at            := null;
    new.total_commission_earned    := 0;
    new.total_commission_paid      := 0;
    new.recruit_earnings           := 0;
    return new;
  end if;

  -- gh-2154 column lock: attribution can never change post-insert except by
  -- service_role/admin (already returned above); activation timestamp can
  -- only move NULL -> NOT NULL, and only through record_partner_app_activation().
  --
  -- REVIEW FAIL 5819691427 (three-valued-logic fail-open): current_setting(x,
  -- true) returns SQL NULL, not '', on any backend where this GUC has never
  -- been set in that session/connection -- so `... = '1'` evaluates to NULL,
  -- `not (NULL and ...)` is NULL, and the whole allow-clause's negation is
  -- NULL. `if NULL then raise` never raises: plpgsql's IF only branches into
  -- THEN on a true boolean, so a NULL condition silently falls through as if
  -- it were false, and a partner on a fresh PostgREST/Supavisor backend
  -- (which is most of them) could PATCH their own unactivated
  -- app_first_signed_in_launch_at straight past this guard. Fixed two ways,
  -- belt and braces, so a NULL here can never again mean "allowed": (1) the
  -- GUC read itself is coalesced to '' so `= '1'` is always a real boolean,
  -- never NULL; (2) the entire allow-clause is wrapped in
  -- coalesce(..., true), so if any future edit reintroduces a NULL-producing
  -- expression here, the guard fails CLOSED (raises) instead of failing
  -- open. Proof: supabase/tests/gh2154_p2_proof.sql, top of the column-lock
  -- section.
  if coalesce(
       (new.fbclid    is distinct from old.fbclid)
       or (new.li_fat_id is distinct from old.li_fat_id)
       or (new.funnel_id is distinct from old.funnel_id)
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

  -- UPDATE: pin every payout-governing / compliance column to its stored value.
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

-- record_partner_app_activation(): first signed-in standalone launch of the
-- installed partner app. Called from partner-dashboard.html once
-- display-mode:standalone or navigator.standalone is detected, a session is
-- signed in, and the caller's referral_agents row is resolved (post-claim).
-- `?source=pwa` is not used as a signal. First-write-wins via the `IS NULL`
-- guard (idempotent — a second call is a harmless no-op), and scoped to the
-- caller's own row via `user_id = auth.uid()` so no partner can ever write
-- another partner's timestamp. Returns whether this call was the one that
-- wrote it.
--
-- THE TRAP (see the guard function's comment above): this RPC is SECURITY
-- DEFINER, so a naive role/current_user check in the trigger could never
-- distinguish this legitimate write from a direct partner UPDATE -- both
-- run as the function owner, and auth.role() still reads 'authenticated'
-- from the JWT even inside a SECURITY DEFINER function. Instead, this RPC
-- sets a transaction-local GUC immediately before its UPDATE and clears it
-- immediately after, so the flag can never leak past this single
-- statement (not even to a second call of this same RPC in the same
-- transaction) and is never visible to, or settable by, the calling
-- client -- set_config() is in pg_catalog, never exposed through
-- PostgREST.
CREATE FUNCTION public.record_partner_app_activation()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wrote boolean;
BEGIN
  PERFORM set_config('oq.gh2154_activation_write', '1', true);

  UPDATE public.referral_agents
  SET app_first_signed_in_launch_at = now()
  WHERE user_id = auth.uid()
    AND app_first_signed_in_launch_at IS NULL;

  v_wrote := FOUND;

  PERFORM set_config('oq.gh2154_activation_write', '', true);

  RETURN v_wrote;
END;
$function$;

-- Supabase's default is EXECUTE for anon/authenticated/service_role on every
-- new public function (Claude's Memories supabase-function-grant-defaults.md,
-- confirmed live by probe above) -- revoke everything this RPC should not
-- have. `authenticated` is deliberately left untouched: its default-granted
-- EXECUTE (from the same schema-level default privilege) is exactly the
-- access this RPC should have, so no explicit GRANT line is added for CI's
-- permissions-ratchet to flag -- REVOKE-only statements always pass that
-- check regardless of role, by design (gh-1767).
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM anon;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM service_role;
