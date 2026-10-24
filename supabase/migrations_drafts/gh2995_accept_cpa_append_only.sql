-- gh-2995 (part b of #2444): server-side, append-only contractor CPA acceptance via accept_cpa(p_version text).
-- STATUS (gh-1438, as of 2026-10-23T13:27:20Z): NOT APPLIED
-- EVIDENCE: drafted on PR branch gh-2995-accept-cpa; production read-only SELECT 2026-10-23: table public.contractor_cpa_acceptances absent (0 rows in information_schema.tables), function accept_cpa absent (0 rows in pg_proc), public.cpa_versions has one is_current row 'v1-2026-04'
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh2995_accept_cpa_append_only_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh2995_accept_cpa_append_only_pre-flight.md  Proof (BEGIN ... ROLLBACK, is_test rows only): supabase/tests/gh2995_accept_cpa_proof.sql
--
-- What changes: (1) new table public.contractor_cpa_acceptances, one row per acceptance, never updated or deleted
-- (BEFORE UPDATE/DELETE row trigger and BEFORE TRUNCATE trigger refuse; clients have SELECT only);
-- (2) new SECURITY DEFINER function public.accept_cpa(p_version text), executable by authenticated only. In ONE
-- transaction it appends the acceptance row (server now(), IP and user agent from request.headers, the version id),
-- updates the caller's own contractors row (cpa_version, cpa_accepted_at, needs_cpa_reattestation=false,
-- agreement_accepted_at on a first acceptance only; agreement_version is NEVER written, D-366 keeps it separate from cpa_version) and appends the
-- activity_log 'cpa_accepted' row with metadata and is_test.
-- p_version must equal the single is_current row of public.cpa_versions (the same gate as gh-2443), so a stale or
-- invented id is refused. record_cpa_ip() is NOT touched or dropped (pages not yet switched keep working).
-- activity_log titles are the existing strings the pages write today, byte for byte; no new user-facing wording.

CREATE TABLE IF NOT EXISTS public.contractor_cpa_acceptances (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id     uuid        NOT NULL,   -- recorded value, deliberately NO foreign key (evidence outlives the account; Ben ruling on #3037)
  user_id           uuid        NOT NULL,   -- recorded value, deliberately NO foreign key to auth.users (no CASCADE, no RESTRICT)
  agreement_version text        NOT NULL CHECK (agreement_version ~ '^v[0-9]+-[0-9]{4}-[0-9]{2}$'),
  kind              text        NOT NULL CHECK (kind IN ('first', 'reaccept')),
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  accepted_ip       text,
  accepted_ua       text,
  is_test           boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS contractor_cpa_acceptances_contractor_idx
  ON public.contractor_cpa_acceptances (contractor_id, accepted_at);

ALTER TABLE public.contractor_cpa_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cpa_acceptances_select_own ON public.contractor_cpa_acceptances;
CREATE POLICY cpa_acceptances_select_own ON public.contractor_cpa_acceptances
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS cpa_acceptances_select_admin ON public.contractor_cpa_acceptances;
CREATE POLICY cpa_acceptances_select_admin ON public.contractor_cpa_acceptances
  FOR SELECT TO authenticated USING ((auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com');

REVOKE ALL ON TABLE public.contractor_cpa_acceptances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.contractor_cpa_acceptances TO authenticated;

CREATE OR REPLACE FUNCTION public.cpa_acceptances_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'contractor_cpa_acceptances is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS cpa_acceptances_no_update_delete ON public.contractor_cpa_acceptances;
CREATE TRIGGER cpa_acceptances_no_update_delete
  BEFORE UPDATE OR DELETE ON public.contractor_cpa_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.cpa_acceptances_append_only();

DROP TRIGGER IF EXISTS cpa_acceptances_no_truncate ON public.contractor_cpa_acceptances;
CREATE TRIGGER cpa_acceptances_no_truncate
  BEFORE TRUNCATE ON public.contractor_cpa_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION public.cpa_acceptances_append_only();

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

-- ---------------------------------------------------------------------------------------------------------------
-- gh-2995 / #3037 F1: take contractor write off the acceptance columns (CTO ruling 6044699314(b)).
-- Redefines public.contractors_freeze_privileged_columns(). Base = the LIVE body read 2026-10-24 from project
-- yeszghaspzwwstvsrioa (pg_get_functiondef), every existing pin preserved. Changes, and only these:
--   INSERT: agreement_accepted_at, agreement_version, cpa_version, cpa_accepted_at := NULL (a contractor cannot create a pre-accepted row).
--   UPDATE: those four columns pinned to OLD; needs_cpa_reattestation is now pinned outright (the gh-2443 clear-only exception is
--           removed because accept_cpa() is the only clearer now; the admin email and non-'authenticated' roles stay exempt).
-- accept_cpa() is SECURITY DEFINER owned by the migration role, so current_user <> 'authenticated' inside it and it passes the
-- existing exemption at the top of this function; no new flag is needed.
CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only constrain direct end-user (authenticated) writes. service_role (Edge Functions / cron)
  -- and SECURITY DEFINER system triggers run as a non-'authenticated' role => exempt.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- Admin account is exempt (mirrors the existing admin_update_contractors policy).
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;      -- gh-1425 path 1
    NEW.stripe_payment_method_id       := NULL;       -- gh-1425 path 1
    NEW.stripe_payment_method_last4    := NULL;       -- gh-1425 path 1
    NEW.agreement_accepted_at          := NULL;       -- gh-2995: only accept_cpa() writes acceptance
    NEW.agreement_version              := NULL;       -- gh-2995
    NEW.cpa_version                    := NULL;       -- gh-2995
    NEW.cpa_accepted_at                := NULL;       -- gh-2995
    RETURN NEW;
  END IF;

  -- UPDATE: pin every privileged column to its stored value (silently ignore change attempts).
  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  NEW.needs_cpa_reattestation        := OLD.needs_cpa_reattestation;   -- gh-2995: replaces the gh-2443 clear-only exception; accept_cpa() clears it
  NEW.agreement_accepted_at          := OLD.agreement_accepted_at;     -- gh-2995
  NEW.agreement_version              := OLD.agreement_version;         -- gh-2995
  NEW.cpa_version                    := OLD.cpa_version;               -- gh-2995
  NEW.cpa_accepted_at                := OLD.cpa_accepted_at;           -- gh-2995
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;              -- gh-1425 path 1
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;        -- gh-1425 path 1
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;     -- gh-1425 path 1
  RETURN NEW;
END;
$function$;
