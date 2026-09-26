-- gh-2154 (rate-limit fix, discovered CEO RUN 71 pr2223-fix3, 2026-09-26) --
-- register_partner()'s rate-limit gate (gh973, 2026-08-18) keyed every
-- anon/authenticated caller on the SAME bucket, because it passed
-- auth.uid() as the bucket key and auth.uid() is NULL for every anonymous
-- browser signup. All of re-1/ins-1/hi-1's live partner funnels, EVERY
-- future partner funnel, and all is_test QA/video-recording traffic drew
-- from that one 10/hour + 30/day pool. Confirmed live (SELECT only,
-- yeszghaspzwwstvsrioa, 2026-09-26T22:xx Z): today's 30/30 daily cap was
-- consumed entirely by is_test=true rows (0 real signups) -- QA exhausted
-- the budget before a single real realtor/agent/inspector could sign up,
-- and the mechanism as shipped could not tell the difference between them.
--
-- Fix: split the single shared bucket into three independent
-- rate_limit_config rows, all still enforced through the EXISTING generic
-- public.check_rate_limit() engine (unchanged -- other callers of that
-- engine are unaffected):
--
--   1. 'register_partner'         -- PER-CLIENT budget for real signups.
--      Keyed by a salted hash of the caller's IP (public.rate_limit_client_key,
--      new helper below), read the same way the existing v_ip/v_ua parsing
--      already does from current_setting('request.headers'). Falls back to
--      the shared NULL key only when no IP header is present at all (rare;
--      keeps that edge case at least as safe as the old global bucket was).
--      Tightened from the old 10/hour+30/day (which had to cover ALL real
--      traffic combined) to 8/hour + 20/day PER CLIENT -- a real person
--      signing up once from one IP is nowhere near this; a script hammering
--      from one IP now only burns its own budget, never anyone else's.
--
--   2. 'register_partner_test'    -- NEW bucket, is_test ONLY (same
--      public.is_test_email() check the function already trusts for
--      v_is_test -- never the caller-supplied p_is_test flag, which is
--      still honored only for the service_role webhook path exactly as
--      before). QA/video-recording/CI traffic draws from this bucket and
--      can NEVER block a real signup again, by construction -- it shares no
--      rate_limit_config row, no caller_id key, and no code path with the
--      real-signup buckets below.
--
--   3. 'register_partner_global'  -- NEW generous platform-wide ceiling
--      (500/day, per the task's own recommended default) as the actual
--      abuse backstop: a botnet spraying signups from many different IPs
--      still hits a hard wall, but at a number that should never be within
--      reach of legitimate traffic.
--
-- ALERTING (platform_alerts_log), and why it is a SEPARATE pg_cron job
-- rather than an insert-then-RAISE inside register_partner itself: verified
-- empirically this session (scratch DB probe, see pre-flight.md "Alert
-- Delivery Mechanism") that PL/pgSQL rolls back ALL work done inside a
-- function's own BEGIN...EXCEPTION block -- including an INSERT issued
-- moments before the RAISE -- once that RAISE propagates past the block,
-- because reaching any EXCEPTION handler (matched or not) requires first
-- rolling back to that block's implicit savepoint. register_partner already
-- has such a block (WHEN unique_violation), so an alert INSERT placed right
-- before its own `RAISE EXCEPTION 'rate_limited: ...'` would NEVER actually
-- land -- confirmed this is also why register_partner's/track_referral_
-- click's `rate_limits.blocked` bookkeeping rows are 0/0 in production
-- today despite check_rate_limit() unconditionally trying to insert one on
-- every refusal: same pre-existing rollback, not something this fix
-- introduces. A NEW function, public.check_register_partner_global_budget(),
-- is scheduled on pg_cron every 15 minutes; it reads the (reliably
-- persisted, since it is only ever written on the SUCCESS path, which never
-- rolls back) count of allowed register_partner_global calls today and
-- writes a deduped 'rate_limit_global_warning' (>=80%) or
-- 'rate_limit_global_exhausted' (>=100%) row to platform_alerts_log. This
-- is a periodic reconciliation rather than an in-request write, but it is
-- the only version of "ALERTS instead of failing silently" that actually
-- persists given the pattern above -- and a 15-minute worst-case detection
-- lag is a reasonable trade against real-time alerting that provably never
-- fires.
--
-- 'register_partner_service_role' (the Meta Lead Ads webhook's own bucket,
-- added gh-2154 P-5r) is completely untouched by this migration -- it was
-- already split off from the anon bucket by function_name and is not part
-- of the bug this fixes.
--
-- Register-partner's own validation, insert, and error-handling logic
-- (agent_type, email format, duplicate check, agreement stamping, etc.) is
-- otherwise BYTE-IDENTICAL to the live function -- diffed by hand against
-- the pg_get_functiondef() pulled fresh from yeszghaspzwwstvsrioa this
-- session. The only relocation is the request.headers parse, moved earlier
-- in the function body (from just before the is_test/meta_lead_id block to
-- the very top) because the new per-client key needs v_ip before the
-- rate-limit gate runs; it is a pure, side-effect-free header read, so
-- moving it earlier changes nothing observable.
--
-- D-numbers: D-182 (deploy tier 3), D-221 (Path A deploy)
-- Tier (D-261/R-097): 3B -- see pre-flight.md "Tier Classification". This
-- is a CREATE OR REPLACE of register_partner(), a live anon-callable RPC
-- with real production traffic; an RPC *behavior* change on a live anon
-- endpoint is judged 3B even though nothing here is destructive DDL, per
-- the task's own framing. DRAFT ONLY -- NOT APPLIED. No apply_migration
-- call was made against yeszghaspzwwstvsrioa this session; SELECT-only, per
-- program rules. This session does not file the 24h risk-brief GitHub issue
-- either (program rules: "do not file new GitHub issues") -- flagged in the
-- PR body and report instead for Ben/Dustin to open if they want the
-- window to run before applying.
--
-- Rollback: gh2154_register_partner_rate_limit_fix_rollback.sql
-- Pre-flight: gh2154_register_partner_rate_limit_fix_pre-flight.md

BEGIN;

-- 1. New helper: deterministic, salted pseudo-uuid for a raw IP string, so
--    the per-client rate-limit key can reuse check_rate_limit()'s existing
--    (function_name, caller_id uuid) shape without adding a new column or
--    new key type to rate_limits, and without storing the raw IP anywhere.
--    NULL in, NULL out (caller falls back to the old shared-NULL-key
--    behavior when no IP header is present at all).
--
--    Known limitation, documented rather than silently assumed away: this
--    is a hash, not encryption -- IPv4 space is small enough that anyone
--    who also has this function's source (i.e. anyone with repo/DB access,
--    already a trusted population here) could brute-force it back to an
--    IP. That is an acceptable trade for a rate-limit bucket key (it is
--    never exposed to a client, never joined against PII, and its only
--    consumer is check_rate_limit()'s COUNT(*) against rate_limits) but it
--    is not a privacy-grade anonymization primitive and should not be
--    reused as one.
CREATE OR REPLACE FUNCTION public.rate_limit_client_key(p_ip text)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_ip IS NULL OR btrim(p_ip) = '' THEN NULL
    ELSE (
      substr(md5('gh2223-rate-limit-client-key-v1:' || btrim(p_ip)), 1, 8) || '-' ||
      substr(md5('gh2223-rate-limit-client-key-v1:' || btrim(p_ip)), 9, 4) || '-' ||
      '4' || substr(md5('gh2223-rate-limit-client-key-v1:' || btrim(p_ip)), 14, 3) || '-' ||
      'a' || substr(md5('gh2223-rate-limit-client-key-v1:' || btrim(p_ip)), 18, 3) || '-' ||
      substr(md5('gh2223-rate-limit-client-key-v1:' || btrim(p_ip)), 21, 12)
    )::uuid
  END;
$function$;

-- Danger pattern #9 (migration-author checklist): Supabase grants EXECUTE
-- to anon/authenticated on every new public function by default. This
-- helper is only ever called from inside register_partner()'s own
-- SECURITY DEFINER body (which runs as the function owner, who always has
-- implicit EXECUTE on its own functions) -- no role needs a direct grant.
REVOKE ALL ON FUNCTION public.rate_limit_client_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_client_key(text) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_client_key(text) FROM authenticated;

-- 2. rate_limit_config rows.
--    (a) Tighten the existing 'register_partner' row to per-client scale
--        now that it is no longer shared by all real traffic combined.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner', 8, 20, 150, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26): re-keyed from a single global anon bucket (auth.uid() is NULL for every anon caller, so ALL real signups + ALL QA traffic shared one 10/hr+30/day pool -- QA alone exhausted it 2026-09-26, blocking every real partner signup for the rest of the UTC day) to PER-CLIENT (public.rate_limit_client_key(ip) as the bucket key). 8/hour+20/day+150/month per client is a starting judgment call, not traffic-validated -- raise if a legitimate shared-IP office ever gets throttled. Real abuse protection now lives in register_partner_global; is_test traffic now lives in register_partner_test and never touches this row.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

--    (b) NEW: is_test-only bucket. Generous -- it exists to bound runaway
--        test loops, not to ever throttle ordinary QA -- and fully
--        separate from every real-signup bucket.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner_test', 100, 300, 3000, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26): dedicated bucket for register_partner() calls where public.is_test_email(email) is true (QA, video-recording runs, CI). Deliberately generous -- its only job is to stop a genuinely runaway test loop, never to ration ordinary QA -- and it shares no key, row, or code path with real-signup traffic, so QA can never again exhaust a real users budget.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

--    (c) NEW: generous global ceiling across ALL real (non-test) clients,
--        the actual abuse backstop. Per the task's own recommended
--        default: 500/day. Protects against a botnet spraying signups from
--        many different IPs (which the per-client bucket alone cannot
--        catch); ALERTS at 80% and on exhaustion instead of refusing
--        silently at a low number.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner_global', 120, 500, 6000, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26): platform-wide ceiling across all REAL (non-test) register_partner signups, independent of the per-client register_partner bucket. This is the abuse backstop for a botnet spraying signups across many IPs, which a per-client key alone cannot catch. What it protects against: unbounded referral_agents row creation / spam signups at a scale far beyond any plausible real launch-week volume across 20 funnels. Numbers are a starting judgment call (task-recommended 500/day), not traffic-validated -- raise if real volume ever approaches it. Reaching it, or crossing 80% of max_per_day, writes to platform_alerts_log (deduped hourly) instead of only returning a silent rate_limited error, so this is caught operationally before it ever blocks a real signup.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

-- 3. register_partner(): re-keyed rate-limit gate. Signature UNCHANGED
--    (every existing caller -- 5+ partner-funnel pages, the invite-accept
--    flow, meta-leadgen-webhook -- keeps working with no code change on
--    their side). Validation/insert/error-handling logic below the gate is
--    otherwise byte-identical to the live function.
CREATE OR REPLACE FUNCTION public.register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_service_area text DEFAULT NULL::text, p_referred_by_note text DEFAULT NULL::text, p_recruit_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_photo_url text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_utm_content text DEFAULT NULL::text, p_is_test boolean DEFAULT false, p_fbclid text DEFAULT NULL::text, p_li_fat_id text DEFAULT NULL::text, p_funnel_id text DEFAULT NULL::text, p_meta_lead_id text DEFAULT NULL::text)
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
  v_rate_global  jsonb;
  v_headers      jsonb;
  v_ip           text;
  v_ua           text;
  v_is_test      boolean;
  v_probe_is_test boolean;
  v_client_key   uuid;
  v_is_service_role boolean;
  v_meta_lead_id text;
  v_status       text;
  v_agreement_version_to_write text;
  v_agreement_accepted_at      timestamptz;
  v_agreement_attestation      jsonb;
  -- v3-2026-09 (gh-2155 HI-0b / #2166), copied verbatim from #2166's
  -- CREATE OR REPLACE -- see the ORDERING note above the PRECONDITION guard.
  v_agreement_version CONSTANT text := 'v3-2026-09';
BEGIN
  -- gh-2154 P-5r (LEGAL-READ FAIL 5833717530 + REVIEW FAIL 5833742114):
  -- computed once, used for three separate gates below -- (1) which
  -- rate_limit_config bucket this call draws from, (2) whether
  -- p_meta_lead_id is honored, (3) whether this INSERT stamps a v3-2026-09
  -- agreement acceptance the caller has no actual consent behind.
  -- meta-leadgen-webhook/index.ts's Supabase client is
  -- createClient(supabaseUrl, serviceRoleKey) -- service_role -- so it is
  -- the only caller this ever affects; P-1's browser signup forms
  -- (partner-re/insurance/inspectors/adjusters/other.html) call this RPC as
  -- anon/authenticated and are completely unaffected. Fail-closed: a NULL
  -- auth.role() (same three-valued-logic trap noted throughout this
  -- migration) counts as NOT service_role, never as an allow.
  v_is_service_role := COALESCE(auth.role() = 'service_role', false);

  -- gh-2223 fix: header parse moved up from just before the is_test/
  -- meta_lead_id block (below) to here, because the per-client rate-limit
  -- key needs v_ip before the gate runs. Pure, side-effect-free header
  -- read -- moving it earlier changes nothing observable.
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

  IF v_is_service_role THEN
    -- UNCHANGED from gh-2154 P-5r: the webhook draws from its own bucket,
    -- keyed the same way (auth.uid(), NULL for service_role too, but never
    -- shared with anon traffic since the function_name differs). Not part
    -- of the gh2223 bug and not touched by this fix.
    v_rate := public.check_rate_limit(
      p_function_name => 'register_partner_service_role',
      p_user_id       => auth.uid()
    );
    IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
      RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
    END IF;
  ELSE
    -- gh-2223 fix (this migration): real anon/authenticated signups used to
    -- share ONE bucket keyed by auth.uid() -- NULL for every anonymous
    -- caller -- so QA/video-recording traffic could (and on 2026-09-26 did)
    -- exhaust the entire day's budget for every real partner signup
    -- platform-wide. is_test is derived the SAME way v_is_test below
    -- derives it for a non-service-role caller (public.is_test_email() on
    -- the email only -- p_is_test is never honored here, unchanged from
    -- before), so a caller cannot buy into the generous test bucket by
    -- simply passing p_is_test=true.
    v_probe_is_test := public.is_test_email(lower(btrim(COALESCE(p_email, ''))));
    v_client_key     := public.rate_limit_client_key(v_ip);

    IF v_probe_is_test THEN
      v_rate := public.check_rate_limit(
        p_function_name => 'register_partner_test',
        p_user_id       => NULL
      );
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner test-bucket rate limit exceeded');
      END IF;
    ELSE
      -- (1) per-client budget -- stops one caller (bot, single office NAT,
      -- a mashed refresh button) from itself, without touching anyone
      -- else's signups.
      v_rate := public.check_rate_limit(
        p_function_name => 'register_partner',
        p_user_id       => v_client_key
      );
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
      END IF;

      -- (2) generous platform-wide ceiling -- the real abuse backstop.
      -- Refusal itself is real-time (this RAISE happens on every call, same
      -- as any other rate-limit check). The ALERT for this bucket is
      -- deliberately NOT written here -- see the long comment at the top of
      -- this file ("ALERTING ... and why it is a SEPARATE pg_cron job") for
      -- why an insert placed right before this RAISE would never actually
      -- persist. public.check_register_partner_global_budget(), scheduled
      -- on pg_cron below, is what writes platform_alerts_log for this
      -- bucket.
      v_rate_global := public.check_rate_limit(
        p_function_name => 'register_partner_global',
        p_user_id       => NULL
      );
      IF NOT COALESCE((v_rate_global->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate_global->>'reason', 'register_partner rate limit exceeded');
      END IF;
    END IF;
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

  -- REVIEW FAIL 5833742114 must-fix 2: p_meta_lead_id is honored (like
  -- p_is_test above) ONLY for the service_role caller -- otherwise ANY anon
  -- browser client could stamp an arbitrary meta_lead_id on its own row,
  -- forging Meta-lead attribution and pre-occupying a real leadgen_id so the
  -- genuine webhook delivery later hits duplicate_meta_lead and is silently
  -- skipped. An anon/authenticated caller's p_meta_lead_id is discarded
  -- (NULL), same fail-closed COALESCE shape as v_is_test above.
  v_meta_lead_id := CASE WHEN v_is_service_role
                         THEN NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '')
                         ELSE NULL
                    END;

  -- LEGAL-READ FAIL 5833717530 (blocking finding): the webhook path (Meta
  -- Lead Ads) never collected the partner's agreement acceptance -- the
  -- lead only ticked Meta's own lead-ad consent, never OtterQuote's Partner
  -- Terms checkbox. Stamping partner_agreement_version/accepted_at/
  -- attestation and defaulting status to 'active' (the table's own DEFAULT)
  -- for that row would fabricate a consent record for a click that never
  -- happened. For a service_role caller (webhook only -- see
  -- v_is_service_role above) this INSERT now writes NO agreement stamp
  -- (version NULL, accepted_at NULL, attestation the column's own
  -- NOT NULL DEFAULT '{}'::jsonb, never a fabricated IP/UA/timestamp) and
  -- an explicit status of 'pending' (already a valid value of
  -- referral_agents_status_check -- ALTER TABLE ... ADD COLUMN wired to
  -- baseline schema line 3072, no CHECK-constraint migration needed).
  -- 'pending' -> 'active' only happens when the partner actually accepts
  -- v3-2026-09 through the P-1 form, reached via a signed invite link --
  -- see supabase/functions/partner-invite-accept/ and js/partner-invite.js
  -- in this same PR. Every OTHER caller (P-1's own browser signup forms,
  -- anon/authenticated) is completely unaffected: they still stamp the
  -- agreement and insert as 'active', exactly as before this migration.
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

-- 4. NEW: the register_partner_global alert reconciler. Runs independently
--    of any register_partner() call (see the long comment above about why
--    an in-request insert-then-RAISE never persists). Reads ONLY the
--    already-persisted "allowed" rows for register_partner_global (which
--    are written on the success path and never rolled back) and writes a
--    deduped platform_alerts_log row when today's count crosses 80% or
--    100% of max_per_day. SECURITY DEFINER so it can read rate_limit_config
--    and rate_limits and write platform_alerts_log regardless of who/what
--    pg_cron executes it as; not callable by anon/authenticated (danger
--    pattern #9) since nothing outside pg_cron needs to call it directly.
CREATE OR REPLACE FUNCTION public.check_register_partner_global_budget()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_config    public.rate_limit_config%ROWTYPE;
  v_day_count int;
BEGIN
  SELECT * INTO v_config FROM public.rate_limit_config WHERE function_name = 'register_partner_global';
  IF NOT FOUND OR NOT v_config.enabled THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_day_count
  FROM public.rate_limits
  WHERE function_name = 'register_partner_global'
    AND caller_id IS NULL
    AND called_at > now() - interval '1 day'
    AND NOT blocked;

  IF v_day_count >= v_config.max_per_day THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_alerts_log
      WHERE function_name = 'register_partner'
        AND alert_type = 'rate_limit_global_exhausted'
        AND acknowledged_at IS NULL
        AND sent_at > now() - interval '1 hour'
    ) THEN
      INSERT INTO public.platform_alerts_log (alert_type, function_name, message)
      VALUES ('rate_limit_global_exhausted', 'register_partner',
        format('register_partner_global ceiling reached: %s/%s real partner signups in the last 24h. Real signups are being refused platform-wide until this rolls off -- this is the abuse-protection backstop (register_partner_global), not the normal per-client limit (register_partner).', v_day_count, v_config.max_per_day));
    END IF;
  ELSIF v_day_count >= ceil(v_config.max_per_day * 0.8) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_alerts_log
      WHERE function_name = 'register_partner'
        AND alert_type = 'rate_limit_global_warning'
        AND acknowledged_at IS NULL
        AND sent_at > now() - interval '1 hour'
    ) THEN
      INSERT INTO public.platform_alerts_log (alert_type, function_name, message)
      VALUES ('rate_limit_global_warning', 'register_partner',
        format('register_partner_global at %s/%s real partner signups in the last 24h (80%% warning threshold).', v_day_count, v_config.max_per_day));
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_register_partner_global_budget() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_register_partner_global_budget() FROM anon;
REVOKE ALL ON FUNCTION public.check_register_partner_global_budget() FROM authenticated;

-- Same pg_cron pattern this repo already uses for its other periodic
-- sweeps (e.g. gh2154 P-4 partner-onboarding-cron, gh1932 homeowner-signup-
-- sweep), except this one is a direct SQL call (no net.http_post / Edge
-- Function round trip needed -- the whole check is a COUNT(*) and a
-- conditional INSERT). 15-minute cadence matches those siblings' cadence.
SELECT cron.schedule(
  'gh2223-register-partner-global-budget-check',
  '*/15 * * * *',
  $cron$SELECT public.check_register_partner_global_budget();$cron$
);

COMMIT;
