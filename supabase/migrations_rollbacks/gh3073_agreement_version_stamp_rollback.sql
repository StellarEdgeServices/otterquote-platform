-- gh-3073 ROLLBACK: restore the gh-2995 accept_cpa() body exactly and remove the single-row agreement-version source.
-- Run manually only if the gh-3073 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- contractors.agreement_version values already stamped by the forward function are NOT reverted (they are valid D-366 stamps).
-- The function below is the accept_cpa() definition from supabase/migrations_drafts/gh2995_accept_cpa_append_only.sql on main (29be3b24), byte for byte.
-- The gh-2995 table, trigger functions and contractors_freeze_privileged_columns() are untouched by this file.

CREATE OR REPLACE FUNCTION public.accept_cpa(p_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_ctr     public.contractors%ROWTYPE;
  v_headers jsonb;
  v_ip      text;
  v_ua      text;
  v_first   boolean;
  v_kind    text;
  v_id      uuid;
  v_at      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- The only acceptable version is the single current one (same gate as gh-2443).
  IF p_version IS DISTINCT FROM (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1) THEN
    RAISE EXCEPTION 'invalid_agreement_version' USING ERRCODE = '22023';
  END IF;

  -- The caller's own contractor row only (contractors.user_id is unique); lock it so two accepts serialise.
  SELECT * INTO v_ctr FROM public.contractors WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized: no contractor for caller' USING ERRCODE = '42501';
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

  v_first := v_ctr.agreement_accepted_at IS NULL;
  v_kind  := CASE WHEN v_first THEN 'first' ELSE 'reaccept' END;

  INSERT INTO public.contractor_cpa_acceptances
    (contractor_id, user_id, agreement_version, kind, accepted_at, accepted_ip, accepted_ua, is_test)
  VALUES
    (v_ctr.id, v_uid, p_version, v_kind, v_at, v_ip, v_ua, v_ctr.is_test IS TRUE)
  RETURNING id INTO v_id;

  UPDATE public.contractors
  SET cpa_version              = p_version,
      cpa_accepted_at          = v_at,
      needs_cpa_reattestation  = false,
      agreement_accepted_at    = CASE WHEN v_first THEN v_at ELSE agreement_accepted_at END
  WHERE id = v_ctr.id;

  INSERT INTO public.activity_log (user_id, event_type, title, metadata, created_at, is_test)
  VALUES (
    v_uid,
    'cpa_accepted',
    CASE WHEN v_first
         THEN 'Accepted Contractor Partner Agreement (' || p_version || ')'
         ELSE 'Accepted updated Contractor Partner Agreement (' || p_version || ')' END,
    jsonb_build_object(
      'acceptance_id',     v_id,
      'agreement_version', p_version,
      'kind',              v_kind,
      'accepted_ip',       v_ip,
      'accepted_ua',       v_ua
    ),
    v_at,
    v_ctr.is_test IS TRUE
  );

  RETURN jsonb_build_object('acceptance_id', v_id, 'accepted_at', v_at, 'agreement_version', p_version, 'kind', v_kind);
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_cpa(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_cpa(text) TO authenticated;

DROP TABLE IF EXISTS public.agreement_version_current;
