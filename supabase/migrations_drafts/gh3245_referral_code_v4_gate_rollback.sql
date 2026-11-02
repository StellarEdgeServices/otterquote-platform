-- STATUS (gh-1438, as of 2026-11-02T14:10:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3245_referral_code_v4_gate (forward, rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-02 under #3245 (refs #3243, #3244; CTO RUN 92 claim cto-2026-11-02T13:06:08Z). Live definition read with pg_get_functiondef on project yeszghaspzwwstvsrioa 2026-11-02: md5(prosrc) first 8 characters = 654640a4, byte-identical to
--   supabase/migrations/20260101000000_v000_baseline_schema.sql lines 1971-2070 (SECURITY DEFINER, search_path public, pg_temp). No database was written.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Exact rollback of gh3245_referral_code_v4_gate.sql: get_or_create_customer_referral_code() is restated as the live body it replaced
-- (md5 first 8 characters 654640a4). Customer rows created while the gate was live are kept (they are ordinary referral_agents rows); nothing else is touched.
-- After a rollback every customer, accepted or not, gets a code again, which is the pre-gate behaviour.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.get_or_create_customer_referral_code()');
  IF v_md5 IS NULL OR left(v_md5, 8) NOT IN ('2d523222', '654640a4') THEN
    RAISE EXCEPTION 'gh3245 referral-code rollback: get_or_create_customer_referral_code() is neither the gh3245 body nor the live body (md5 first 8 characters %); restore by hand', left(v_md5, 8);
  END IF;
END
$guard$;

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

COMMIT;
