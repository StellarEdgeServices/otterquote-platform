-- gh-2154 P-5: Meta Lead Ads webhook — partner path only.
--
-- Adds a nullable, UNIQUE meta_lead_id text column to referral_agents (the
-- dedupe key for meta-leadgen-webhook: a re-delivered Meta webhook event for
-- the same leadgen_id must never create a second partner row), and extends
-- register_partner() with an additive trailing p_meta_lead_id parameter,
-- following the exact gh-846 / P-2 pattern already used twice on this
-- function: old signature DROPped explicitly, new signature CREATEd with
-- the new param appended DEFAULT NULL, function body otherwise
-- byte-identical to P-2's 20-arg definition
-- (20260924160000_gh2154_p2_partner_attribution_activation.sql).
--
-- meta_lead_id is nullable because register_partner() is also called by
-- P-1's browser signup flow and any other future caller that has no Meta
-- lead to attach — only meta-leadgen-webhook ever passes a non-null value.
-- UNIQUE (allowing multiple NULLs, standard Postgres unique-constraint
-- semantics) is the actual dedupe guarantee at the database level;
-- meta-leadgen-webhook's own isDuplicate() pre-check is a defense-in-depth
-- read, not the sole guard — a race between two concurrent deliveries of
-- the same leadgen_id is caught here as a unique_violation, surfaced to the
-- caller as 'duplicate_meta_lead' (never a raw constraint-name error, same
-- convention as the existing 'partner_exists' branch on the email unique
-- index).
--
-- PIN (Kevin, answering this build's original QUESTION: YES, pin it):
-- referral_agents_guard_payout_columns() is CREATE OR REPLACEd below,
-- starting from its CURRENT LIVE body (md5(pg_get_functiondef(...)) first
-- 8 hex = 81c6af22, confirmed by a read-only probe immediately before
-- writing this migration -- same live-body-adoption precedent as P-2's own
-- DRIFT NOTE), with exactly one addition: `or (new.meta_lead_id is
-- distinct from old.meta_lead_id)` inside the existing
-- coalesce(..., true)-wrapped attribution/activation condition, alongside
-- fbclid/li_fat_id/funnel_id. Same fail-closed shape: service_role and
-- is_admin_email() still return NEW unconditionally (checked first, above
-- this block, unchanged); the INSERT branch is untouched (register_partner()
-- is SECURITY DEFINER and bypasses this trigger's UPDATE branch entirely on
-- INSERT); only a non-admin, non-service_role UPDATE that changes
-- meta_lead_id now raises 42501, same as the three existing pinned columns.
--
-- rate_limit_config: meta-leadgen-webhook calls check_rate_limit() (same
-- convention as record-lead-details / check-email-exists), so it needs a
-- config row or the RPC denies by default (fail-closed) on every call —
-- see gh1724's own note about exactly this trap.
--
-- REVIEW SHOULD-FIX (PR #2162, comment 5821998080, folded into P-5 by
-- Kevin): register_partner() took p_is_test straight from the caller, so
-- any anon client (P-1's own browser signup form included) could pass
-- p_is_test=true for a normal, real email and self-mark as a test account.
-- is_test is now derived server-side inside register_partner() as:
--   v_is_test := public.is_test_email(v_email)
--                OR (COALESCE(p_is_test, false)
--                    AND COALESCE(auth.role() = 'service_role', false))
-- public.is_test_email() (created below, IMMUTABLE, search_path pinned,
-- EXECUTE revoked from PUBLIC/anon/authenticated -- called only from
-- inside this SECURITY DEFINER function, so no grant is needed) mirrors
-- js/auth.js's isTestEmail() verbatim: trim, lowercase, suffix-match
-- '@otterquote-internal.test'. A client-supplied p_is_test=true is honored
-- ONLY when auth.role() actually is 'service_role' -- fail-closed: a NULL
-- auth.role() (which happens on some backends, same three-valued-logic
-- trap as the REVIEW FAIL 5819691427 note on the guard trigger below) is
-- explicitly coalesced to false, i.e. counts as NOT service_role, never as
-- an allow. Confirmed via supabase/functions/meta-leadgen-webhook/index.ts:
-- its Supabase client is createClient(supabaseUrl, serviceRoleKey) --
-- service_role -- so the webhook's allowlist-driven is_test still passes
-- through untouched. The P-1 pages already send
-- p_is_test: Auth.isTestEmail(email), which this reproduces server-side,
-- so client behavior for real test emails (anon or otherwise) is
-- unchanged; only a normal email + a lying anon p_is_test=true now
-- resolves to false.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924213000_gh2154_p5_meta_lead_id_rollback.sql
-- — drops the 21-arg register_partner, recreates the POST-#2166 20-arg
-- definition (v3-2026-09 stamped -- see the ORDERING note below, NOT the
-- pre-#2166 md5 6b44199b body), drops the rate_limit_config row, restores
-- the guard trigger, drops meta_lead_id (which also drops its unique
-- constraint), and drops public.is_test_email().
--
-- ORDERING (P-5b correction, Kevin): this migration DROPs the live 20-arg
-- register_partner() and CREATEs a fresh 21-arg one, so it can only ever
-- carry forward whatever v_agreement_version literal was live on the 20-arg
-- function the instant before this migration ran. #2166 (gh-2155 HI-0b, PR
-- #2166) independently CREATE OR REPLACEs that same 20-arg function to bump
-- v_agreement_version from 'v2-2026-08' to 'v3-2026-09' -- same signature,
-- one literal changed, nothing else. The two migrations are safe in exactly
-- one order: #2166 applies FIRST (so its CREATE OR REPLACE lands on the
-- signature that still exists), THEN this migration applies (so its
-- DROP+CREATE correctly matches and replaces the v3-stamped function,
-- carrying v3-2026-09 forward instead of reintroducing v2-2026-08). The
-- reverse order either regresses the HI-0b legal fix or -- if #2166 lands
-- after this migration has already dropped the signature #2166's CREATE OR
-- REPLACE targets -- creates a second, overloaded register_partner instead
-- of replacing anything. This migration's own v_agreement_version literal
-- below is therefore 'v3-2026-09' (copied verbatim from #2166's
-- CREATE OR REPLACE body, not invented), and the PRECONDITION guard
-- immediately below makes the wrong order impossible to apply silently:
-- it inspects the LIVE 20-arg register_partner() before this migration
-- touches anything and RAISE EXCEPTIONs if #2166's v3-2026-09 stamp is not
-- already present. See PR #2182 body ("#2166 applies first (guarded); P-5
-- carries v3") and #2154 comment thread for the full ordering discussion.

-- PRECONDITION (P-5b, Kevin): fail loudly, before touching any object,
-- if #2166 (gh-2155 HI-0b) has not already applied to this database. #2166
-- CREATE OR REPLACEs the live 20-arg public.register_partner(), changing
-- only v_agreement_version from 'v2-2026-08' to 'v3-2026-09'; that stamp is
-- the unique marker #2166 introduces on this function. This migration's own
-- DROP FUNCTION below only matches (and only correctly replaces) that same
-- 20-arg signature -- if it doesn't exist yet, or exists but was never
-- bumped to v3-2026-09, applying this migration would either error on the
-- DROP or silently re-stamp v2-2026-08 and regress the HI-0b legal fix. See
-- the ORDERING note above.
DO $gh2154_p5_precondition$
DECLARE
  v_def text;
BEGIN
  BEGIN
    SELECT pg_get_functiondef(
      'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text)'::regprocedure
    ) INTO v_def;
  EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION 'gh2154_p5 PRECONDITION FAILED: public.register_partner (20-arg, pre-P5 signature) was not found on this database. This migration cannot verify #2166 (gh-2155 HI-0b, v3-2026-09 agreement-version bump) has applied. Apply supabase/migrations/20260925012956_gh2155_hi0b_agreement_v3.sql BEFORE this migration.';
  END;

  IF v_def IS NULL OR v_def NOT LIKE '%v3-2026-09%' THEN
    RAISE EXCEPTION 'gh2154_p5 PRECONDITION FAILED: #2166 (gh-2155 HI-0b) has not applied yet -- the live public.register_partner() (20-arg) does not stamp v3-2026-09. This migration (gh-2154 P-5) DROPs and replaces register_partner() and MUST apply AFTER #2166, or the v3-2026-09 legal fix is silently regressed to v2-2026-08. Apply supabase/migrations/20260925012956_gh2155_hi0b_agreement_v3.sql first, then re-run this migration.';
  END IF;
END;
$gh2154_p5_precondition$;

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS meta_lead_id text UNIQUE;

-- Old 20-arg overload dropped explicitly (gh-846 / P-2 pattern) so the new
-- 21-arg signature never coexists with it.
DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text
);

-- Helper mirroring js/auth.js's isTestEmail() verbatim:
--   (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test')
-- IMMUTABLE (pure function of its input), search_path pinned, and EXECUTE
-- revoked from PUBLIC/anon/authenticated since it is only ever called
-- inside register_partner() (SECURITY DEFINER) -- no grant needed for that.
CREATE FUNCTION public.is_test_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(btrim(coalesce(p_email, ''))) LIKE '%@otterquote-internal.test';
$$;

REVOKE EXECUTE ON FUNCTION public.is_test_email(text) FROM PUBLIC, anon, authenticated;

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
  p_funnel_id        text DEFAULT NULL,
  p_meta_lead_id     text DEFAULT NULL
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
  v_is_test      boolean;
  -- v3-2026-09 (gh-2155 HI-0b / #2166), copied verbatim from #2166's
  -- CREATE OR REPLACE -- see the ORDERING note above the PRECONDITION guard.
  v_agreement_version CONSTANT text := 'v3-2026-09';
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

  -- REVIEW SHOULD-FIX (PR #2162, comment 5821998080): is_test is derived
  -- server-side, never taken verbatim from the caller. A real test email
  -- (per public.is_test_email(), mirroring js/auth.js's isTestEmail())
  -- always marks true regardless of caller/role. Otherwise, a caller-
  -- supplied p_is_test=true is honored ONLY for the service_role webhook
  -- caller (meta-leadgen-webhook's allowlist-driven is_test) -- fail
  -- closed: a NULL auth.role() counts as NOT service_role, never as an
  -- allow, via the explicit COALESCE(..., false).
  v_is_test := public.is_test_email(v_email)
               OR (COALESCE(p_is_test, false)
                   AND COALESCE(auth.role() = 'service_role', false));

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    partner_agreement_version, partner_agreement_accepted_at,
    partner_agreement_attestation,
    fbclid, li_fat_id, funnel_id, meta_lead_id
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
    v_is_test,
    v_agreement_version,
    now(),
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    ),
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), ''),
    NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '')
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
    ELSIF v_constraint = 'referral_agents_meta_lead_id_key' THEN
      RAISE EXCEPTION 'duplicate_meta_lead';
    END IF;
    RAISE;
END;
$function$;

-- No explicit GRANT here — same reasoning as P-2's migration: this
-- project's schema already runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`, so the
-- new function already has the same grants as the one it replaces with no
-- explicit GRANT line for CI's permissions-ratchet to flag.

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('meta-leadgen-webhook', 120, 1000, 20000, true, 0.0000, 0.00,
   'gh2154 P-5: Meta Lead Ads webhook, partner path only. Keyed on a per-IP synthetic UUID (Meta''s own webhook delivery IPs, not an end user) since the caller is server-to-server with no real user_id. Rate-limits AFTER signature verification only, so a forged/unsigned request never reaches this check. Limits are a starting judgment call sized for webhook burst delivery, not human traffic -- raise if legitimate Meta delivery volume is ever throttled.')
ON CONFLICT (function_name) DO NOTHING;

-- Pin meta_lead_id the same way P-2 pinned fbclid/li_fat_id/funnel_id.
-- Body below is the CURRENT LIVE body (md5 first-8 = 81c6af22) with exactly
-- one addition inside the coalesce(...) allow-clause. See ROLLBACK for the
-- exact pre-migration restore.
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
  --
  -- gh-2154 P-5: meta_lead_id added to this same coalesce(...)-wrapped
  -- clause, alongside fbclid/li_fat_id/funnel_id -- it is the
  -- meta-leadgen-webhook dedupe key and must not be partner-writable any
  -- more than the other attribution columns are.
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
