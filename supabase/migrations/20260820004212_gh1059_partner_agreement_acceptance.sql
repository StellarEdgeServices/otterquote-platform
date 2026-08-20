-- gh-1059 [P1 BLOCKER]: partner-agreement.html has an acceptance checkbox and
-- the acceptance is written nowhere. Mirrors the contractor path's shape
-- (cpa_version / cpa_accepted_at / ic_24511_attestation on `contractors`) —
-- do not invent a second convention.
--
-- Tier: 3A, autonomous under D-182/D-261. Diff is purely additive — four new
-- nullable/defaulted columns, and register_partner()'s parameter list and
-- existing behavior are UNCHANGED; the only change to the function body is
-- populating three new INSERT targets from data already available to it
-- (PostgREST's request.headers GUC, present on every RPC call regardless of
-- auth state — same source record_cpa_ip() reads for the contractor path).
-- Nothing destructive, nothing on a money or consent path.
--
-- AC5 (board Q10 "FLAG." ruling, reused here): the 13 existing referral_agents
-- rows are left with these columns NULL. We do not backfill a fabricated
-- accepted_at for rows that never went through a persisted acceptance flow —
-- NULL is the honest, auditable statement "no record of acceptance exists,"
-- which is the true state. No row is deleted or altered.

-- ── 1. Columns on referral_agents ───────────────────────────────────────────
-- partner_agreement_version / _accepted_at: flat columns, same shape as
-- contractors.cpa_version / cpa_accepted_at.
-- partner_agreement_attestation: JSONB IP/UA stamp, same shape as
-- contractors.ic_24511_attestation. Keyed by version so every acceptance
-- (initial + any future re-acceptance) is preserved rather than overwritten.
-- needs_partner_reacceptance: same shape as contractors.needs_cpa_reattestation
-- — the flag Section 17's re-acknowledgment mechanism sets when a future
-- Section 4 amendment ships, so a UI can gate on it exactly like the CPA modal.

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS partner_agreement_version      TEXT,
  ADD COLUMN IF NOT EXISTS partner_agreement_accepted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS partner_agreement_attestation  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS needs_partner_reacceptance      BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.referral_agents.partner_agreement_version IS
  'gh-1059: version of partner-agreement.html accepted at signup (or last re-acceptance). NULL = no persisted acceptance on record (true for all 13 pre-gh1059 rows).';
COMMENT ON COLUMN public.referral_agents.partner_agreement_accepted_at IS
  'gh-1059: timestamp of the acceptance named by partner_agreement_version.';
COMMENT ON COLUMN public.referral_agents.partner_agreement_attestation IS
  'gh-1059: JSONB keyed by agreement version, e.g. {"v1-2026-08": {"accepted_ip": "...", "accepted_ua": "..."}}. Mirrors contractors.ic_24511_attestation''s IP/UA shape; keyed (not overwritten) so a future re-acceptance does not erase the original record.';
COMMENT ON COLUMN public.referral_agents.needs_partner_reacceptance IS
  'gh-1059: set true when a Section-4 material change ships (Section 17) and a specific partner has not yet re-accepted the new version. Mirrors contractors.needs_cpa_reattestation.';

-- ── 2. register_partner(): stamp acceptance at signup time ─────────────────
-- Signature and every existing parameter/behavior are unchanged. The only
-- diff is: (a) two new local vars for header extraction, (b) three new
-- columns in the INSERT list, (c) their values.
--
-- Called anonymously (pre-auth) from every partner signup page, gated
-- client-side on the "I agree to Partner Terms" checkbox (verified present
-- on all 5 partner-*.html signup forms; `required` attribute + a
-- pre-submit guard blocks the RPC call unless checked) — the same trust
-- model the checkbox has always had, now actually persisted server-side.
--
-- v_agreement_version is a server-side constant, not a client-supplied
-- parameter — the signature is not touched here, and the client cannot
-- assert which version it "accepted." Bump this string (and add the
-- companion migration) whenever partner-agreement.html's substantive terms
-- change; #1075 (gated on this issue) is the first such bump.

CREATE OR REPLACE FUNCTION public.register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_service_area text DEFAULT NULL::text, p_referred_by_note text DEFAULT NULL::text, p_recruit_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_photo_url text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_utm_content text DEFAULT NULL::text, p_is_test boolean DEFAULT false)
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
  v_agreement_version CONSTANT text := 'v1-2026-08';
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

  -- gh-1059: server-side IP/UA capture, same source as record_cpa_ip() for
  -- the contractor path. request.headers is populated by PostgREST for every
  -- RPC call, anon or authenticated, so this works at pre-auth signup time.
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
    partner_agreement_attestation
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
    )
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

-- ── 3. record_partner_agreement_reacceptance(): Section 17 re-ack mechanism ─
-- AC4: "a re-acknowledgment mechanism you cannot record is not a mechanism."
-- Minimal, callable, ownership-checked SECURITY DEFINER RPC — the backend
-- half of Section 17's re-acknowledgment requirement. No UI calls this yet;
-- wiring a partner-dashboard re-acceptance surface (analogous to the
-- contractor CPA re-accept modal) is follow-up scope for whichever PR ships
-- the next Section 4 amendment (e.g. the D-301 rename in #1075/#1054), since
-- that is the first time this mechanism will actually need to be exercised.
--
-- One call does everything (unlike the contractor path's two-step
-- client-update + record_cpa_ip split) because referral_agents has no
-- unauthenticated path here — the caller is always the linked partner —
-- so there is no reason to split the version/timestamp write from the IP
-- stamp across two round trips.

CREATE OR REPLACE FUNCTION public.record_partner_agreement_reacceptance(p_referral_agent_id uuid, p_agreement_version text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_headers jsonb;
  v_ip      text;
  v_ua      text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM referral_agents
    WHERE id = p_referral_agent_id
      AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for referral_agent %', p_referral_agent_id;
  END IF;

  IF p_agreement_version IS NULL OR btrim(p_agreement_version) = '' THEN
    RAISE EXCEPTION 'missing_agreement_version';
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

  UPDATE referral_agents
  SET
    partner_agreement_version     = btrim(p_agreement_version),
    partner_agreement_accepted_at = now(),
    needs_partner_reacceptance    = false,
    partner_agreement_attestation =
      COALESCE(partner_agreement_attestation, '{}'::jsonb)
      || jsonb_build_object(
           btrim(p_agreement_version),
           jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
         )
  WHERE id = p_referral_agent_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_partner_agreement_reacceptance(uuid, text) TO authenticated;
