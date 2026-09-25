-- gh-2154 P-5 proof script: server-side is_test derivation
-- (review should-fix, PR #2162 comment 5821998080, folded into P-5 by Kevin).
--
-- P-5b NOTE (Kevin): this script now also inlines the migration's
-- PRECONDITION guard (step 2) and the corrected v3-2026-09 rollback target
-- (step 4) — see the ORDERING note in
-- supabase/migrations/20260924213000_gh2154_p5_meta_lead_id.sql. That
-- guard means this script can ONLY be run for real (or line up cleanly)
-- once #2166 (gh-2155 HI-0b) has actually applied to the target database
-- and its 20-arg register_partner() stamps v3-2026-09 — running it against
-- today's prod (still v2-2026-08, #2166 unapplied) will hit the guard's
-- RAISE EXCEPTION at step 2 by design, proving the guard works, but
-- aborting before steps 3-4 run. This is expected, not a script bug.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against production (yeszghaspzwwstvsrioa), AFTER #2166 has applied.
-- NEVER COMMIT.
--
-- This script:
--   0. Applies the columns register_partner() needs (idempotent ADD COLUMN
--      IF NOT EXISTS — a no-op against current prod).
--   1. FAIL-FIRST: installs the vulnerable 21-arg register_partner() exactly
--      as it stood at commit ee7d6fb1 (COALESCE(p_is_test, false) passed
--      straight through, no server-side derivation) and proves the hole:
--      an anon caller passing p_is_test=true for a real email gets
--      is_test=true. Then SAVEPOINT-rolls that back so it never touches
--      the rest of the script.
--   2. Applies this build's actual fix — inlined verbatim from
--      supabase/migrations/20260924213000_gh2154_p5_meta_lead_id.sql —
--      the PRECONDITION guard, public.is_test_email(), the fixed
--      register_partner() (v3-2026-09, service_role-only p_meta_lead_id,
--      service_role-only agreement/status gating, split rate-limit
--      bucket), and the CREATE OR REPLACEd guard trigger.
--   3. Asserts (a)-(d) from the build brief (is_test derivation) against
--      the FIXED function, plus (e)-(g) added for the P-5r correction:
--      (e) anon p_meta_lead_id is ignored: (f) LEGAL-READ FAIL 5833717530
--      -- service_role p_meta_lead_id is honored AND the row is created
--      'pending' with NO agreement stamp; (g) negative control -- a normal
--      anon P-1 signup is unaffected (active, v3-2026-09 stamped).
--   4. Applies this migration's own (P-5b-corrected) rollback (verbatim
--      from
--      supabase/migrations_rollbacks/20260924213000_gh2154_p5_meta_lead_id_rollback.sql)
--      and asserts register_partner is restored to the v3-2026-09 20-arg
--      shape (arg count + agreement-version literal, NOT a hardcoded
--      pre-#2166 md5 — see the rollback file's MD5 NOTE for why), the
--      guard trigger is back to md5 81c6af22, and that
--      public.is_test_email() and meta_lead_id are gone.
--
-- Everything this script writes (test rows, functions, columns) is rolled
-- back by the ROLLBACK that must follow it — no synthetic row, column, or
-- function survives.

BEGIN;

-- ── 0. Columns register_partner() needs (idempotent) ────────────────────
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz,
  ADD COLUMN IF NOT EXISTS meta_lead_id text UNIQUE;

-- ── 1. FAIL-FIRST: the ee7d6fb1 (vulnerable) register_partner() ─────────
SAVEPOINT sp_old_vulnerable;

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text
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
    COALESCE(p_is_test, false),
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

-- Anon caller (no role claim -> auth.role() IS NULL, same as a real anon
-- request through PostgREST with no JWT role claim recognized) passes
-- p_is_test=true for a real, non-test email. Against the VULNERABLE
-- function above this MUST come back true — that is the hole.
DO $$
DECLARE
  v_result jsonb;
  v_is_test boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'FailFirst',
    p_email      => 'real@example.com',
    p_is_test    => true
  );

  SELECT is_test INTO v_is_test FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154_p5_proof FAIL-FIRST PREMISE BROKEN: expected the ee7d6fb1 (vulnerable) register_partner() to give is_test=true for an anon caller passing p_is_test=true on a real email — got %. The fail-first demonstration did not reproduce the hole.', v_is_test;
  END IF;

  RAISE NOTICE 'gh2154_p5_proof FAIL-FIRST: confirmed — against ee7d6fb1''s register_partner(), anon + p_is_test=true + real@example.com gives is_test=true (the hole PR #2162 comment 5821998080 flagged). PASS (fails as expected).';
END $$;

-- Undo the vulnerable function and its synthetic row — never let it touch
-- the rest of this script or persist past this savepoint.
ROLLBACK TO SAVEPOINT sp_old_vulnerable;

-- ── 2. Apply this build's actual fix, inlined verbatim from ─────────────
-- supabase/migrations/20260924213000_gh2154_p5_meta_lead_id.sql

-- PRECONDITION (inlined verbatim from the migration): fails loudly if
-- #2166 (gh-2155 HI-0b, v3-2026-09) has not already applied to this
-- database. See the migration's ORDERING note.
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

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text
);

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
  v_is_service_role boolean;
  v_meta_lead_id text;
  v_status       text;
  v_agreement_version_to_write text;
  v_agreement_accepted_at      timestamptz;
  v_agreement_attestation      jsonb;
  -- v3-2026-09 (gh-2155 HI-0b / #2166), matches the migration's own
  -- ORDERING-note correction.
  v_agreement_version CONSTANT text := 'v3-2026-09';
BEGIN
  -- gh-2154 P-5r (LEGAL-READ FAIL 5833717530 + REVIEW FAIL 5833742114),
  -- inlined verbatim from the migration.
  v_is_service_role := COALESCE(auth.role() = 'service_role', false);

  v_rate := public.check_rate_limit(
    p_function_name => CASE WHEN v_is_service_role THEN 'register_partner_service_role' ELSE 'register_partner' END,
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

  v_is_test := public.is_test_email(v_email)
               OR (COALESCE(p_is_test, false)
                   AND COALESCE(auth.role() = 'service_role', false));

  -- REVIEW FAIL 5833742114 must-fix 2 (inlined verbatim from the migration).
  v_meta_lead_id := CASE WHEN v_is_service_role
                         THEN NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '')
                         ELSE NULL
                    END;

  -- LEGAL-READ FAIL 5833717530 (inlined verbatim from the migration).
  v_status := CASE WHEN v_is_service_role THEN 'pending' ELSE 'active' END;
  v_agreement_version_to_write := CASE WHEN v_is_service_role THEN NULL ELSE v_agreement_version END;
  v_agreement_accepted_at      := CASE WHEN v_is_service_role THEN NULL ELSE now() END;
  v_agreement_attestation      := CASE WHEN v_is_service_role THEN '{}'::jsonb ELSE
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    )
  END;

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    status,
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
    v_status,
    v_agreement_version_to_write,
    v_agreement_accepted_at,
    v_agreement_attestation,
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), ''),
    v_meta_lead_id
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

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('meta-leadgen-webhook', 120, 1000, 20000, true, 0.0000, 0.00,
   'gh2154 P-5: Meta Lead Ads webhook, partner path only.'),
  ('register_partner_service_role', 120, 1000, 20000, true, 0.0000, 0.00,
   'gh2154 P-5r (REVIEW FAIL 5833742114 must-fix 1): register_partner()''s own bucket for the service_role caller, separate from the shared anon bucket.')
ON CONFLICT (function_name) DO NOTHING;

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

-- ── 3. Assertions (a)-(d) against the FIXED function ─────────────────────

-- (a) anon, p_is_test=true + real@example.com -> is_test=false
DO $$
DECLARE
  v_result jsonb;
  v_is_test boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'CaseA',
    p_email      => 'real@example.com',
    p_is_test    => true
  );

  SELECT is_test INTO v_is_test FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'gh2154_p5_proof (a) FAILED: anon + p_is_test=true + real@example.com expected is_test=false, got %.', v_is_test;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (a) PASS: anon + p_is_test=true + real@example.com -> is_test=false.';
END $$;

-- (b) anon, pfw-x@otterquote-internal.test with p_is_test=false -> is_test=true
DO $$
DECLARE
  v_result jsonb;
  v_is_test boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'CaseB',
    p_email      => 'pfw-x@otterquote-internal.test',
    p_is_test    => false
  );

  SELECT is_test INTO v_is_test FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154_p5_proof (b) FAILED: anon + pfw-x@otterquote-internal.test + p_is_test=false expected is_test=true, got %.', v_is_test;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (b) PASS: anon + pfw-x@otterquote-internal.test + p_is_test=false -> is_test=true (pattern wins).';
END $$;

-- (c) service_role, p_is_test=true + a normal email -> is_test=true
DO $$
DECLARE
  v_result jsonb;
  v_is_test boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'CaseC',
    p_email      => 'real2@example.com',
    p_is_test    => true
  );

  SELECT is_test INTO v_is_test FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154_p5_proof (c) FAILED: service_role + p_is_test=true + real2@example.com expected is_test=true, got %.', v_is_test;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (c) PASS: service_role + p_is_test=true + real2@example.com -> is_test=true.';

  -- Reset role for subsequent tests.
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

-- (d) negative control: anon, normal email, p_is_test=false -> is_test=false
DO $$
DECLARE
  v_result jsonb;
  v_is_test boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'CaseD',
    p_email      => 'real3@example.com',
    p_is_test    => false
  );

  SELECT is_test INTO v_is_test FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'gh2154_p5_proof (d) FAILED: anon + real3@example.com + p_is_test=false expected is_test=false, got %.', v_is_test;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (d) PASS (negative control): anon + real3@example.com + p_is_test=false -> is_test=false.';
END $$;

-- (e) REVIEW FAIL 5833742114 must-fix 2: anon + p_meta_lead_id -> ignored (NULL), row still 'active'/stamped normally.
DO $$
DECLARE
  v_result jsonb;
  v_meta_lead_id_col text;
  v_status text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type   => 're_agent',
    p_first_name   => 'GH2154P5',
    p_last_name    => 'CaseE',
    p_email        => 'real-e@example.com',
    p_meta_lead_id => 'forged_leadgen_id_e'
  );

  SELECT meta_lead_id, status INTO v_meta_lead_id_col, v_status FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_meta_lead_id_col IS NOT NULL THEN
    RAISE EXCEPTION 'gh2154_p5_proof (e) FAILED: anon p_meta_lead_id must be ignored (NULL), got %.', v_meta_lead_id_col;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'gh2154_p5_proof (e) FAILED: anon signup expected status=active, got %.', v_status;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (e) PASS: anon p_meta_lead_id is ignored (NULL), row is active.';
END $$;

-- (f) LEGAL-READ FAIL 5833717530: service_role + p_meta_lead_id -> honored, row 'pending', NO agreement stamp.
DO $$
DECLARE
  v_result jsonb;
  v_meta_lead_id_col text;
  v_status text;
  v_agreement_version_col text;
  v_agreement_accepted_at_col timestamptz;
  v_agreement_attestation_col jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type   => 're_agent',
    p_first_name   => 'GH2154P5',
    p_last_name    => 'CaseF',
    p_email        => 'real-f@example.com',
    p_meta_lead_id => 'leadgen_case_f'
  );

  SELECT meta_lead_id, status, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation
    INTO v_meta_lead_id_col, v_status, v_agreement_version_col, v_agreement_accepted_at_col, v_agreement_attestation_col
    FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_meta_lead_id_col IS DISTINCT FROM 'leadgen_case_f' THEN
    RAISE EXCEPTION 'gh2154_p5_proof (f) FAILED: service_role p_meta_lead_id expected leadgen_case_f, got %.', v_meta_lead_id_col;
  END IF;
  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'gh2154_p5_proof (f) FAILED: webhook-sourced row expected status=pending, got %.', v_status;
  END IF;
  IF v_agreement_version_col IS NOT NULL OR v_agreement_accepted_at_col IS NOT NULL OR v_agreement_attestation_col <> '{}'::jsonb THEN
    RAISE EXCEPTION 'gh2154_p5_proof (f) FAILED: webhook-sourced row must NOT stamp an agreement acceptance -- version=%, accepted_at=%, attestation=%.',
      v_agreement_version_col, v_agreement_accepted_at_col, v_agreement_attestation_col;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (f) PASS: service_role p_meta_lead_id honored, row is pending with NO agreement stamp.';

  -- Reset role for subsequent tests.
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

-- (g) negative control confirming (a)-(d)'s anon path still stamps the real agreement acceptance normally (unaffected by (e)/(f)).
DO $$
DECLARE
  v_result jsonb;
  v_status text;
  v_agreement_version_col text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P5',
    p_last_name  => 'CaseG',
    p_email      => 'real-g@example.com'
  );

  SELECT status, partner_agreement_version INTO v_status, v_agreement_version_col FROM referral_agents WHERE id = (v_result->>'id')::uuid;

  IF v_status IS DISTINCT FROM 'active' OR v_agreement_version_col IS DISTINCT FROM 'v3-2026-09' THEN
    RAISE EXCEPTION 'gh2154_p5_proof (g) FAILED: normal P-1 signup expected status=active + agreement v3-2026-09, got status=%, version=%.', v_status, v_agreement_version_col;
  END IF;
  RAISE NOTICE 'gh2154_p5_proof (g) PASS (negative control): P-1 anon signup is unaffected -- active, v3-2026-09 stamped.';
END $$;

-- ── 4. Rollback proof: apply this migration's own rollback and confirm ──
-- everything is restored to its exact pre-migration shape.
DELETE FROM public.rate_limit_config WHERE function_name IN ('meta-leadgen-webhook', 'register_partner_service_role');

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text, text
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
  -- v3-2026-09 -- P-5b rollback correction: restores the POST-#2166 body,
  -- not the pre-#2166 v2-2026-08 one. See the rollback file's MD5 NOTE.
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

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS meta_lead_id;

DROP FUNCTION IF EXISTS public.is_test_email(text);

-- Assert everything is back to its pre-P5 (post-#2166) shape.
--
-- P-5b NOTE: register_partner()'s restored md5 is intentionally NOT
-- asserted against a hardcoded literal here. Pre-#2166 it was a known
-- constant (6b44199b), but this rollback now restores the POST-#2166
-- (v3-2026-09) body, whose exact catalog md5 cannot be known until #2166
-- has actually applied to the target database (see the rollback file's
-- MD5 NOTE). Instead this asserts the two properties that must hold
-- regardless of environment: the restored function has the pre-P5 20-arg
-- signature (proves the regprocedure cast below resolves at all -- an
-- undefined_function error means the DROP/CREATE left the wrong
-- signature live), and its body stamps v3-2026-09, not v2-2026-08 (proves
-- the P-5b correction actually took -- this is the part the original,
-- uncorrected rollback got wrong). Whoever runs this for real should ALSO
-- manually confirm the printed md5 matches a value captured immediately
-- after #2166 applied (see the rollback file's MD5 NOTE) before trusting
-- the restore as byte-exact.
DO $$
DECLARE
  v_rp_md5 text;
  v_rp_def text;
  v_guard_md5 text;
  v_helper_exists boolean;
  v_column_exists boolean;
BEGIN
  SELECT pg_get_functiondef(
    'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text)'::regprocedure
  ) INTO v_rp_def;
  v_rp_md5 := substr(md5(v_rp_def), 1, 8);

  IF v_rp_def IS NULL THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: register_partner() 20-arg signature not found after rollback -- the P-5 rollback did not correctly restore it.';
  END IF;

  IF v_rp_def NOT LIKE '%v3-2026-09%' THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: restored register_partner() does not stamp v3-2026-09 (P-5b correction did not take -- got md5 first-8 %).', v_rp_md5;
  END IF;

  IF v_rp_def LIKE '%v2-2026-08%' THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: restored register_partner() still contains v2-2026-08 -- the rollback regressed the HI-0b/#2166 fix (md5 first-8 %).', v_rp_md5;
  END IF;

  SELECT substr(md5(pg_get_functiondef(
    'public.referral_agents_guard_payout_columns()'::regprocedure
  )), 1, 8) INTO v_guard_md5;

  IF v_guard_md5 IS DISTINCT FROM '81c6af22' THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: referral_agents_guard_payout_columns() md5 first-8 = % (expected 81c6af22, unaffected by #2166).', v_guard_md5;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'is_test_email' AND pronamespace = 'public'::regnamespace
  ) INTO v_helper_exists;
  IF v_helper_exists THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: public.is_test_email() still exists after rollback.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'referral_agents' AND column_name = 'meta_lead_id'
  ) INTO v_column_exists;
  IF v_column_exists THEN
    RAISE EXCEPTION 'gh2154_p5_proof ROLLBACK FAILED: referral_agents.meta_lead_id still exists after rollback.';
  END IF;

  RAISE NOTICE 'gh2154_p5_proof ROLLBACK: register_partner() restored to v3-2026-09 20-arg shape, md5 first-8=% (record this and cross-check against the value captured right after #2166 applied), guard md5=% (expected 81c6af22), is_test_email() gone, meta_lead_id gone. PASS.', v_rp_md5, v_guard_md5;
END $$;

ROLLBACK;
