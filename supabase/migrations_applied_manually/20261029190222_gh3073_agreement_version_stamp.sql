-- gh-3073 (follow-up to #2995 / PR #3037, D-366): stamp contractors.agreement_version SERVER-SIDE inside accept_cpa().
-- STATUS (gh-1438, as of 2026-10-28T15:58:26Z): NOT APPLIED
-- EVIDENCE: drafted on PR branch kv/gh3073-mzya on top of main 29be3b24 (the merge of PR #3037). No production read was made by the author (no database connection). Base = the accept_cpa() body in supabase/migrations_drafts/gh2995_accept_cpa_append_only.sql on main; the pre-flight lists the read-only SELECTs the applier runs first (the live body must still equal that base, and public.agreement_version_current must be absent).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair, R-097 24-hour notice, a recorded apply). Apply only AFTER the gh-2995 forward file is applied (accept_cpa() and contractor_cpa_acceptances must exist).
-- Rollback: supabase/migrations_rollbacks/gh3073_agreement_version_stamp_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3073_agreement_version_stamp_pre-flight.md  Proof (BEGIN ... ROLLBACK, throwaway schema): supabase/tests/gh3073_agreement_version_proof.sql
--
-- What changes: (1) new single-row table public.agreement_version_current holding the server's current contractor AGREEMENT version
-- (value 'v2-2026-10', the value the pre-approval pages and react-app AGREEMENT_VERSION write today). It is a SEPARATE row, not public.cpa_versions
-- (D-366 keeps the CPA version and the agreement version distinct). RLS on, no policies, every client role revoked: only the migration
-- owner and SECURITY DEFINER functions can read or change it; a later version bump is a Tier 3B migration (UPDATE of the one row).
-- (2) CREATE OR REPLACE public.accept_cpa(p_version text): same body as gh-2995, plus: reads the single row (refuses with 55000
-- agreement_version_unset if absent) and sets contractors.agreement_version from it on a first acceptance (on a re-acceptance only a NULL is filled).
-- The signature, return value, activity_log strings and EXECUTE grants are unchanged. contractors_freeze_privileged_columns() is NOT touched:
-- a direct client UPDATE of agreement_version stays pinned to OLD, and accept_cpa() (SECURITY DEFINER) passes its existing exemption.

CREATE TABLE IF NOT EXISTS public.agreement_version_current (
  singleton     boolean     PRIMARY KEY DEFAULT true CHECK (singleton),   -- the only legal value is true, so the table holds at most one row
  version_label text        NOT NULL CHECK (version_label ~ '^v[0-9]+-[0-9]{4}-[0-9]{2}$'),
  set_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (true, 'v2-2026-10') ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.agreement_version_current ENABLE ROW LEVEL SECURITY;   -- no policies: deny by default for every non-owner role

REVOKE ALL ON TABLE public.agreement_version_current FROM PUBLIC, anon, authenticated, service_role;

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
  v_agr     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- The only acceptable version is the single current one (same gate as gh-2443).
  IF p_version IS DISTINCT FROM (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1) THEN
    RAISE EXCEPTION 'invalid_agreement_version' USING ERRCODE = '22023';
  END IF;

  -- gh-3073: the server-held current AGREEMENT version (single row, D-366: distinct from the CPA version above).
  -- Read here, never taken from a parameter. A missing row refuses the call rather than stamping NULL.
  SELECT a.version_label INTO v_agr FROM public.agreement_version_current a WHERE a.singleton;
  IF v_agr IS NULL THEN
    RAISE EXCEPTION 'agreement_version_unset' USING ERRCODE = '55000';
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
      agreement_accepted_at    = CASE WHEN v_first THEN v_at ELSE agreement_accepted_at END,
      -- gh-3073: stamped from the server-held source on a first acceptance; on a re-acceptance only a NULL is filled,
      -- an existing value is never moved (a CPA re-accept is not an acceptance of a newer agreement version).
      agreement_version        = CASE WHEN v_first OR agreement_version IS NULL THEN v_agr ELSE agreement_version END
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
