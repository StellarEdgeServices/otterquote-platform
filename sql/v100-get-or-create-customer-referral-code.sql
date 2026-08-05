-- ============================================================================
-- v100 — Customer self-referral code RPC  (GitHub #624 follow-up)
-- ============================================================================
--
-- PROBLEM
--   The D-211 (2026-06-13) security sprint locked referral_agents behind RLS.
--   Every other referral_agents writer (partner-re/-insurance/-adjusters/
--   -inspectors/-other.html) was migrated to the register_partner() SECURITY
--   DEFINER RPC (#571). The customer self-referral path on
--   refer-a-friend.html never was: fetchOrCreateReferralCode() still did a
--   direct client .insert([...]).select().single(), which hits the same
--   write-then-read RLS gap (no SELECT policy exposes a freshly inserted row
--   the way the client expects it to). Today's fix (PR #624) added an honest
--   error state instead of silently building a fake /ref/error link, but left
--   customers with disabled sharing UI and no way to actually get a code.
--
-- SOLUTION
--   A SECURITY DEFINER RPC, matching the v95/v97 architecture (register_partner,
--   track_referral_click, claim_partner_account). Identity comes from
--   auth.uid()/auth.jwt() only — no client-supplied identity parameters — so a
--   caller can only ever read or create their own row. Idempotent get-or-create
--   keyed on (user_id, agent_type='customer', status='active'). Falls back
--   through the same first/last-name derivation the client used
--   (profiles.full_name, else JWT user_metadata.full_name, else the email
--   local-part) since first_name/last_name are NOT NULL on referral_agents.
--   unique_code is never supplied — the existing referral_agents_generate_code
--   BEFORE INSERT trigger (collision-checked loop over generate_referral_code())
--   populates it, exactly like register_partner relies on.
--
-- TIER: 3A (additive — new function only; no schema change, no RLS change,
--       nothing destructive). Owner-approved 2026-08-05.
--
-- GRANTS: migration-author Danger Pattern #9 — Supabase default privileges
--   grant anon EXECUTE on new functions unless explicitly revoked (the v95a
--   near-miss). Explicit per-role REVOKE + GRANT below, with a negative probe.
--
-- Rollback: DROP FUNCTION IF EXISTS public.get_or_create_customer_referral_code();
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_or_create_customer_referral_code()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_email      text := lower(btrim(COALESCE(auth.jwt() ->> 'email', '')));
  v_meta       jsonb := COALESCE(auth.jwt() -> 'user_metadata', '{}'::jsonb);
  v_full_name  text;
  v_name_parts text[];
  v_first      text;
  v_last       text;
  v_row        public.referral_agents%ROWTYPE;
  v_constraint text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- 1. Idempotent read: return the caller's existing active customer code.
  SELECT * INTO v_row
    FROM public.referral_agents
   WHERE user_id = v_uid
     AND agent_type = 'customer'
     AND status = 'active';

  IF FOUND THEN
    RETURN jsonb_build_object(
      'unique_code',             v_row.unique_code,
      'payments_blocked',        v_row.payments_blocked,
      'w9_notification_sent_at', v_row.w9_notification_sent_at,
      'w9_submitted_at',         v_row.w9_submitted_at,
      'created',                 false
    );
  END IF;

  IF v_email = '' THEN
    RAISE EXCEPTION 'missing_email: no verified email on session';
  END IF;

  -- 2. Derive first/last name — same fallback chain as the client code it
  --    replaces: profiles.full_name, else JWT user_metadata.full_name, else
  --    the email local-part (first_name/last_name are NOT NULL).
  SELECT NULLIF(btrim(full_name), '') INTO v_full_name
    FROM public.profiles WHERE id = v_uid;

  IF v_full_name IS NULL THEN
    v_full_name := NULLIF(btrim(COALESCE(v_meta ->> 'full_name', '')), '');
  END IF;

  IF v_full_name IS NOT NULL THEN
    v_name_parts := regexp_split_to_array(v_full_name, '\s+');
    v_first := NULLIF(v_name_parts[1], '');
    v_last  := CASE WHEN array_length(v_name_parts, 1) > 1
                     THEN array_to_string(v_name_parts[2:array_length(v_name_parts, 1)], ' ')
                     ELSE NULL END;
  END IF;

  v_first := COALESCE(v_first, split_part(v_email, '@', 1));
  v_last  := COALESCE(v_last, split_part(v_email, '@', 1));

  -- 3. Insert. unique_code is never supplied — the
  --    referral_agents_generate_code BEFORE INSERT trigger populates it via
  --    the same collision-checked loop register_partner relies on.
  BEGIN
    INSERT INTO public.referral_agents (
      user_id, agent_type, first_name, last_name, email
    ) VALUES (
      v_uid, 'customer', v_first, v_last, v_email
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'referral_agents_email_key' THEN
      -- Concurrent call (double-click / duplicate tab) racing this same
      -- insert, or the email is already attached to a different
      -- referral_agents row (e.g. a partner signup with the same email).
      -- Re-resolve idempotently rather than raising on the common race.
      SELECT * INTO v_row
        FROM public.referral_agents
       WHERE user_id = v_uid AND agent_type = 'customer' AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'email_in_use: this account email is already registered to a different referral agent';
      END IF;
    ELSE
      RAISE;
    END IF;
  END;

  RETURN jsonb_build_object(
    'unique_code',             v_row.unique_code,
    'payments_blocked',        v_row.payments_blocked,
    'w9_notification_sent_at', v_row.w9_notification_sent_at,
    'w9_submitted_at',         v_row.w9_submitted_at,
    'created',                 true
  );
END;
$function$;

COMMENT ON FUNCTION public.get_or_create_customer_referral_code() IS
'Restores customer self-referral code generation (refer-a-friend.html) after D-211 locked referral_agents behind RLS. Get-or-create keyed on auth.uid() only — no client-supplied identity — mirrors the register_partner()/claim_partner_account() SECURITY DEFINER pattern (#571/#594). Idempotent; unique_code is trigger-generated. authenticated EXECUTE only; anon explicitly revoked per Danger Pattern #9.';

-- ── Grants (Danger Pattern #9) ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_or_create_customer_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_or_create_customer_referral_code() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_referral_code() TO authenticated;

-- ── Negative probe — fail the migration if anon can execute ────────────────
DO $probe$
BEGIN
  IF has_function_privilege('anon', 'public.get_or_create_customer_referral_code()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v100 SAFETY: anon has EXECUTE on get_or_create_customer_referral_code() — aborting';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_or_create_customer_referral_code()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v100 SAFETY: authenticated lacks EXECUTE on get_or_create_customer_referral_code() — aborting';
  END IF;
END
$probe$;

COMMIT;
