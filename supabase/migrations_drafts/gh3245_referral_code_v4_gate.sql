-- STATUS (gh-1438, as of 2026-11-02T14:10:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3245_referral_code_v4_gate (forward, rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-02 under #3245 (refs #3243, #3244; CTO RUN 92 claim cto-2026-11-02T13:06:08Z). Live definition read with pg_get_functiondef on project yeszghaspzwwstvsrioa 2026-11-02: md5(prosrc) = 654640a4f472d8fce2e46f6a539eba8e, byte-identical to
--   supabase/migrations/20260101000000_v000_baseline_schema.sql lines 1971-2070 (SECURITY DEFINER, search_path public, pg_temp). No database was written.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3245_referral_code_v4_gate
-- GitHub: #3245 (vehicle, Ben's ruling on #3243 comment 6563033722), refs #3243, #3244, PR #3279. Tier 3B (referral program, change to an existing RPC). Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097 and Dustin's word.
-- DEPENDS ON gh3239_partner_agreement_v4: partner_v4_accepted_at(uuid). Refuses to run without it.
-- !! APPLY ORDER: the refer pages must ship first (see pre-flight "Page coupling"). Both pages call this RPC BEFORE accept_partner_agreement_v4() and
--    throw when it returns no code, so applying this alone breaks first-time acceptance for every customer. !!
-- Rollback: gh3245_referral_code_v4_gate_rollback.sql   Pre-flight: gh3245_referral_code_v4_gate_pre-flight.md
-- Proof: supabase/tests/gh3245_referral_code_v4_gate_proof.sql   Runner: supabase/tests/gh3245_referral_code_v4_gate_proof_run.sh
--
-- What this file does: get_or_create_customer_referral_code() is restated with the live body plus two identical checks (marked gh-3245, the only diff):
--   a caller whose customer row has partner_v4_accepted_at(row.id) IS NULL gets unique_code NULL and v4_acceptance_required true, on both the
--   existing-row path and the create path. It does NOT raise: a raise would roll back the INSERT and accept_partner_agreement_v4() would find no row
--   (it raises no_partner_record). The row (and its trigger-generated code) exists in the database but is never returned until acceptance.
--   An accepted customer gets exactly the live result. Signature, SECURITY DEFINER, search_path and grants (CREATE OR REPLACE keeps them) are unchanged.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.partner_v4_accepted_at(uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3245 referral-code guard: partner_v4_accepted_at(uuid) is missing; apply gh3239_partner_agreement_v4 first';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.get_or_create_customer_referral_code()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('654640a4f472d8fce2e46f6a539eba8e',    -- live body (production 2026-11-02)
                                    '2d5232228e5a039e68147325b3f5d69e') THEN -- this file's body (re-run)
    RAISE EXCEPTION 'gh3245 referral-code guard: get_or_create_customer_referral_code() is neither the live body nor this file''s body (md5 %); re-read it before applying', v_md5;
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
    -- gh-3245 referral-code gate: no code is returned until the customer has accepted Partner Agreement v4-2026-10.
    -- Returns normally (not RAISE) so the row survives: accept_partner_agreement_v4() needs this row to exist.
    IF public.partner_v4_accepted_at(v_row.id) IS NULL THEN
      RETURN jsonb_build_object(
        'unique_code',             NULL,
        'v4_acceptance_required',  true,
        'payments_blocked',        v_row.payments_blocked,
        'w9_notification_sent_at', v_row.w9_notification_sent_at,
        'w9_submitted_at',         v_row.w9_submitted_at,
        'created',                 false
      );
    END IF;

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

  -- gh-3245 referral-code gate (create path): the row exists now, so the customer can accept v4; the code is not returned.
  IF public.partner_v4_accepted_at(v_row.id) IS NULL THEN
    RETURN jsonb_build_object(
      'unique_code',             NULL,
      'v4_acceptance_required',  true,
      'payments_blocked',        v_row.payments_blocked,
      'w9_notification_sent_at', v_row.w9_notification_sent_at,
      'w9_submitted_at',         v_row.w9_submitted_at,
      'created',                 true
    );
  END IF;

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
