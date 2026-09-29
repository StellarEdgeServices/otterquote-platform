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
-- REVISION 2026-09-26 (this file): fixes to REVIEW: FAIL comment 5850688286
-- on PR #2237, at head 6810a0dd. Fixes applied here, referenced by their
-- defect id from that review:
--   D1 (blocking): the per-client rate-limit key was built from
--      COALESCE(x-forwarded-for-first-hop, cf-connecting-ip, x-real-ip) --
--      i.e. it trusted a header the caller fully controls FIRST. Fixed:
--      a separate v_rl_ip is now derived cf-connecting-ip -> x-real-ip ->
--      right-most X-Forwarded-For hop (last resort only), with an IPv6
--      address collapsed to its /64 before hashing -- same cf-connecting-ip-
--      first preference check-email-exists/index.ts's getClientIp() (gh-1724)
--      already established in this repo, though that function's own
--      fallback differs (left-most XFF hop, no x-real-ip step) -- not a
--      byte-for-byte port of it. v_ip (the
--      value stamped into the partner-agreement attestation) is
--      UNCHANGED by this fix -- same spoofable-XFF issue there predates
--      this PR and is explicitly out of scope per the review (routes
--      through LEGAL-READ separately).
--   D2 (blocking): the global-ceiling alert was written only to
--      platform_alerts_log by a new pg_cron reconciler, with nothing to
--      actually deliver it (Mailgun/email) to anyone. Fixed: the pg_cron
--      reconciler and its schedule are REMOVED from this migration.
--      Alerting for register_partner_global (>=80%/day, 100%/day, AND
--      100%/hour) is now added to supabase/functions/platform-health-check
--      /index.ts's existing fireAlert() path (Phase 5 in that file), which
--      already runs every 15 minutes and already has a working Mailgun +
--      dedup path. See that file's diff in this PR for the actual alert
--      logic; nothing here writes platform_alerts_log directly any more.
--   D3 (should-fix): the per-client hash salt was a string literal in
--      source (readable by anyone with repo/DB access, and IPv4 space is
--      small enough to brute-force back to the source IP). Fixed:
--      rate_limit_client_key() now reads a random 32-byte salt from
--      Supabase Vault (created once, below, via vault.create_secret if
--      not already present) and uses extensions.hmac(ip, salt, 'sha256')
--      instead of salted md5. The function is now STABLE (it does a
--      table read), not IMMUTABLE.
--   D4 (should-fix): register_partner_test was keyed by a single shared
--      NULL caller_id, so one abusive caller could exhaust the whole
--      100/300/3000 test bucket for everyone (blocking QA/pre-flight
--      walks platform-wide). Fixed: register_partner_test is now keyed
--      by the SAME per-client key (v_client_key, built from the D1-fixed
--      v_rl_ip) as the real bucket, so one caller can only ever burn its
--      own test allowance. Limits (100/hr, 300/day, 3000/month) are
--      unchanged, now PER CLIENT rather than platform-wide.
--   D5 (should-fix): wording only, see the rollback file and PR body --
--      not a SQL change.
--
-- REVISION 2026-09-26 (2nd fix round): fixes to REVIEW: FAIL comment
-- 5850926064 on PR #2237, at head 8d60a969. All three items below are
-- wording/config fixes only -- no behavior change to any already-reviewed
-- (D1-D5) logic:
--   F1 (blocking, CI red): the D5 rollback-wording comment quoted a 32-hex-
--      char md5 hash, which the repo's Credential Shape Sweep flags as a
--      HEX_RUN_20 finding. Removed from the rollback file's comment (see
--      that file) -- it added nothing anyway.
--   F2 (blocking): the rollback's config UPDATE still restored the
--      pre-existing 10/hr+30/day+300/month row, but the LIVE row was
--      changed to 50/hr+60/day+300/month by the interim #2154 mitigation
--      before this re-review. Fixed in the rollback file to restore
--      50/60/300 (see that file for detail).
--   Reviewer's caveat (non-numbered, still addressed here): a request with
--      no derivable IP at all (v_rl_ip IS NULL -- e.g. the Vault secret is
--      missing, or every one of cf-connecting-ip/x-real-ip/XFF is absent)
--      used to fall through to public.check_rate_limit()'s shared NULL-
--      caller_id key on the SAME 'register_partner' bucket real per-client
--      traffic with a derivable IP also falls back to for its own edge
--      cases, and which review 5850926064 noted "already holds today's
--      signups" at the per-client 20/day cap -- i.e. a genuinely IP-less
--      request could be refused by traffic that has nothing to do with it.
--      Fixed: a request with no derivable IP now draws from its own new
--      'register_partner_no_ip' bucket (see rate_limit_config row (d)
--      below) -- generous, and reset-safe because it is a brand-new
--      function_name with no pre-existing rate_limits history to inherit.
--
-- Fix (unchanged from the first draft; see revisions above for what
-- changed since REVIEW: FAIL): split the single shared bucket into three
-- independent rate_limit_config rows, all still enforced through the
-- EXISTING generic public.check_rate_limit() engine (unchanged -- other
-- callers of that engine are unaffected):
--
--   1. 'register_partner'         -- PER-CLIENT budget for real signups.
--      Keyed by a salted HMAC hash of the caller's IP (public.
--      rate_limit_client_key, new helper below), read the same way the
--      existing v_ip/v_ua parsing already does from
--      current_setting('request.headers'). Falls back to its own dedicated
--      'register_partner_no_ip' bucket (below) only when no IP can be
--      derived at all (rare) -- fixed in the 2nd fix round (REVIEW
--      5850926064 caveat) so that edge case never shares a bucket with any
--      real per-client traffic.
--      8/hour + 20/day + 150/month PER CLIENT.
--
--   2. 'register_partner_test'    -- is_test ONLY (same
--      public.is_test_email() check the function already trusts for
--      v_is_test -- never the caller-supplied p_is_test flag, which is
--      still honored only for the service_role webhook path exactly as
--      before), now ALSO per-client (D4) so one caller can't exhaust it
--      for everyone else.
--
--   3. 'register_partner_global'  -- generous platform-wide ceiling
--      (500/day, per the task's own recommended default) as the actual
--      abuse backstop: a botnet spraying signups from many different IPs
--      still hits a hard wall, but at a number that should never be within
--      reach of legitimate traffic. Alerted on via platform-health-check
--      (D2 above), not via a table insert alone.
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
-- the very top) because the new per-client key needs the derived IP before
-- the rate-limit gate runs; it is a pure, side-effect-free header read, so
-- moving it earlier changes nothing observable.
--
-- D-numbers: D-182 (deploy tier 3), D-221 (Path A deploy)
-- Tier (D-261/R-097): 3B -- see pre-flight.md "Tier Classification". This
-- is a CREATE OR REPLACE of register_partner(), a live anon-callable RPC
-- with real production traffic; an RPC *behavior* change on a live anon
-- endpoint is judged 3B even though nothing here is destructive DDL. DRAFT
-- ONLY -- NOT APPLIED. No apply_migration call was made against
-- yeszghaspzwwstvsrioa this session; SELECT-only, per program rules.
--
-- Rollback: gh2154_register_partner_rate_limit_fix_rollback.sql
-- Pre-flight: gh2154_register_partner_rate_limit_fix_pre-flight.md

BEGIN;

-- 0. D3: Vault salt for the per-client key. Created ONLY if it does not
--    already exist (idempotent -- re-running this migration must not spin
--    a new salt and silently reshuffle every existing caller_id bucket).
--    32 random bytes, hex-encoded, generated server-side -- never appears
--    in source control or in any migration's own text.
DO $vault_seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'rate_limit_ip_salt') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'rate_limit_ip_salt',
      'gh2223 rate-limit fix: HMAC salt for public.rate_limit_client_key(). Never rotate without accepting that every existing caller_id bucket in rate_limits changes shape (harmless -- it is only ever compared to itself going forward, never joined against a stored raw IP).'
    );
  END IF;
END;
$vault_seed$;

-- 1. New helper: deterministic, salted pseudo-uuid for a raw IP (or IPv6
--    /64) string, so the per-client rate-limit key can reuse
--    check_rate_limit()'s existing (function_name, caller_id uuid) shape
--    without adding a new column or new key type to rate_limits, and
--    without storing the raw IP anywhere. NULL in, NULL out (caller falls
--    back to the old shared-NULL-key behavior when no IP can be derived
--    at all).
--
--    D3 fix: the salt is now read from Vault (vault.decrypted_secrets),
--    the same pattern this repo's own pg_cron jobs already use to read
--    cron_service_role_key/cron_secret (see cron.job entries such as
--    process-dunning-cron, platform-health-check-cron). HMAC-SHA256
--    replaces salted md5 -- brute-forcing the IPv4 space back from a
--    caller_id now additionally requires the (never-committed, Vault-
--    only) salt, which anon cannot read (PostgREST does not expose
--    vault.*, and this function is SECURITY DEFINER-only-callable from
--    inside register_partner(), never directly). STABLE, not IMMUTABLE,
--    because it now does a table read.
CREATE OR REPLACE FUNCTION public.rate_limit_client_key(p_ip text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_salt text;
  v_hash bytea;
  v_hex  text;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_salt
  FROM vault.decrypted_secrets
  WHERE name = 'rate_limit_ip_salt';

  IF v_salt IS NULL THEN
    -- Fail closed to the old shared-NULL bucket rather than raising and
    -- breaking every real signup if the Vault secret is ever missing --
    -- the shared bucket is the pre-fix behavior, not a security hole.
    RETURN NULL;
  END IF;

  v_hash := extensions.hmac(btrim(p_ip), v_salt, 'sha256');
  v_hex  := encode(v_hash, 'hex');

  RETURN (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-' ||
    '4' || substr(v_hex, 14, 3) || '-' ||
    'a' || substr(v_hex, 18, 3) || '-' ||
    substr(v_hex, 21, 12)
  )::uuid;
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
   'gh2223 fix (2026-09-26, revised post-REVIEW:FAIL 5850688286): re-keyed from a single global anon bucket (auth.uid() is NULL for every anon caller, so ALL real signups + ALL QA traffic shared one 10/hr+30/day pool -- QA alone exhausted it 2026-09-26, blocking every real partner signup for the rest of the UTC day) to PER-CLIENT (public.rate_limit_client_key(ip) as the bucket key, ip derived cf-connecting-ip -> x-real-ip -> right-most XFF hop only, per D1). 8/hour+20/day+150/month per client is a starting judgment call, not traffic-validated -- raise if a legitimate shared-IP office ever gets throttled. Real abuse protection now lives in register_partner_global; is_test traffic now lives in register_partner_test (also per-client, D4) and never touches this row.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

--    (b) is_test-only bucket, now PER-CLIENT (D4) rather than one shared
--        NULL-key row -- generous, exists to bound a runaway test loop
--        from ONE caller, without letting that one caller exhaust the
--        allowance every other QA run also depends on.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner_test', 100, 300, 3000, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26, revised post-REVIEW:FAIL 5850688286): dedicated, PER-CLIENT (D4) bucket for register_partner() calls where public.is_test_email(email) is true (QA, video-recording runs, CI). Deliberately generous -- its only job is to stop a genuinely runaway test loop FROM ONE CALLER, never to ration ordinary QA -- and it shares no key, row, or code path with real-signup traffic, so QA can never again exhaust a real users budget. Keyed per-client (not a single shared NULL row) so one abusive test caller cannot exhaust this bucket for every other QA/pre-flight-walk run at the same time.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

--    (c) generous global ceiling across ALL real (non-test) clients, the
--        actual abuse backstop. Per the task's own recommended default:
--        500/day. Alerting for this bucket is handled by
--        platform-health-check (D2), not by an insert here.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner_global', 120, 500, 6000, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26, revised post-REVIEW:FAIL 5850688286): platform-wide ceiling across all REAL (non-test) register_partner signups, independent of the per-client register_partner bucket. This is the abuse backstop for a botnet spraying signups across many IPs, which a per-client key alone cannot catch. Numbers are a starting judgment call (task-recommended 500/day), not traffic-validated -- raise if real volume ever approaches it. Alerting on 80%/day, 100%/day and 100%/hour of this bucket is implemented in supabase/functions/platform-health-check/index.ts (fireAlert path, Mailgun + dedup), not by a direct table insert from this migration -- see D2 in the forward migration''s header comment.')
ON CONFLICT (function_name) DO UPDATE SET
  max_per_hour          = EXCLUDED.max_per_hour,
  max_per_day           = EXCLUDED.max_per_day,
  max_per_month         = EXCLUDED.max_per_month,
  enabled               = EXCLUDED.enabled,
  monthly_cost_estimate = EXCLUDED.monthly_cost_estimate,
  monthly_budget_cap    = EXCLUDED.monthly_budget_cap,
  notes                 = EXCLUDED.notes;

--    (d) REVIEW 5850926064 caveat fix: a real (non-test) signup for which
--        NO client IP can be derived at all (v_rl_ip IS NULL -- e.g. every
--        one of cf-connecting-ip/x-real-ip/XFF is absent, or the Vault
--        salt is momentarily missing) used to fall back to the SAME
--        'register_partner' bucket's shared NULL-caller_id key -- the
--        exact bucket the reviewer noted "already holds today's signups"
--        at the per-client 20/day cap, so a genuinely IP-less request
--        could be refused by traffic that has nothing to do with it. Own
--        bucket, generous, and reset-safe (brand-new function_name, no
--        pre-existing rate_limits rows to inherit).
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('register_partner_no_ip', 40, 150, 1500, true, 0.0000, 0.00,
   'gh2223 fix (2026-09-26, 2nd fix round post-REVIEW:FAIL 5850926064): dedicated bucket for real (non-test) register_partner() calls where NO client IP could be derived at all (public.rate_limit_client_key(NULL) -> NULL -- e.g. cf-connecting-ip/x-real-ip/XFF all absent, or the Vault secret rate_limit_ip_salt is momentarily unreadable). Previously these calls silently shared the per-client register_partner bucket''s NULL-key row with every other IP-less caller, which could already be near its cap from unrelated traffic. Generous (40/hr, 150/day, 1500/month) since this path should be rare in normal edge traffic and is not a per-client key -- it is itself a shared bucket across all IP-less callers, same shape as the pre-fix defect but isolated from real per-client traffic and sized well above any plausible legitimate volume of headerless requests.')
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
  v_rl_ip        text;
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
  -- key needs the derived IP before the gate runs. Pure, side-effect-free
  -- header read -- moving it earlier changes nothing observable.
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  -- UNCHANGED (attestation only): v_ip is what gets stamped into
  -- partner_agreement_attestation below. This is the SAME spoofable-XFF
  -- expression the live function already uses for that purpose. REVIEW
  -- FAIL 5850688286 D1 explicitly says: "Leave v_ip, the attestation
  -- accepted_ip, as it is in this PR. It has the same spoofable-XFF
  -- problem in the consent evidence, which predates this PR. Open a
  -- separate issue and route it through LEGAL-READ, because fixing it
  -- changes what the partner-agreement attestation records." Not touched
  -- here for that reason.
  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  -- D1 fix (REVIEW FAIL 5850688286): a SEPARATE derivation, v_rl_ip, used
  -- ONLY for the rate-limit key -- never for the attestation above. Prefers
  -- cf-connecting-ip (set by the Cloudflare edge in front of this project;
  -- cannot be forged by the caller), then x-real-ip, and only as a last
  -- resort the RIGHT-most X-Forwarded-For hop (the left-most hop, used by
  -- the pre-fix code above, is fully caller-controlled -- gh-1724's
  -- check-email-exists/index.ts getClientIp() established the same
  -- cf-connecting-ip-first principle in this repo, though its own fallback
  -- differs -- left-most XFF hop, no x-real-ip step -- so this is not a
  -- byte-for-byte port of that function). An IPv6 address is collapsed
  -- to its /64 before hashing, because one IPv6 host normally controls a
  -- whole /64 and could otherwise rotate through 2^64 buckets.
  v_rl_ip := COALESCE(
    NULLIF(btrim(v_headers->>'cf-connecting-ip'), ''),
    NULLIF(btrim(v_headers->>'x-real-ip'), ''),
    NULLIF(btrim(reverse(split_part(reverse(COALESCE(v_headers->>'x-forwarded-for','')), ',', 1))), '')
  );
  IF v_rl_ip LIKE '%:%' THEN               -- IPv6 -> /64 bucket
    BEGIN
      v_rl_ip := network(set_masklen(v_rl_ip::inet, 64))::text;  -- e.g. '2001:db8:1:2::/64'
    EXCEPTION WHEN OTHERS THEN NULL; END;  -- unparsable: keep raw string
  END IF;

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
    v_client_key     := public.rate_limit_client_key(v_rl_ip);

    IF v_probe_is_test THEN
      -- D4 fix: keyed per-client (v_client_key), not a single shared NULL
      -- row, so one abusive test caller cannot exhaust the whole test
      -- allowance for every other QA/pre-flight-walk run.
      v_rate := public.check_rate_limit(
        p_function_name => 'register_partner_test',
        p_user_id       => v_client_key
      );
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner test-bucket rate limit exceeded');
      END IF;
    ELSE
      -- (1) per-client budget -- stops one caller (bot, single office NAT,
      -- a mashed refresh button) from itself, without touching anyone
      -- else's signups.
      --
      -- REVIEW 5850926064 caveat fix: when v_client_key IS NULL (no client
      -- IP could be derived at all -- rare; e.g. every one of
      -- cf-connecting-ip/x-real-ip/XFF is absent, or the Vault salt is
      -- momentarily unreadable), this call used to draw from the SAME
      -- 'register_partner' bucket's shared NULL-caller_id row that every
      -- other IP-less request also shares -- the exact bucket the review
      -- noted "already holds today's signups" at the per-client 20/day cap,
      -- so one genuinely IP-less request could be refused by unrelated
      -- IP-less traffic. It now draws from its own dedicated
      -- 'register_partner_no_ip' bucket instead (generous, reset-safe --
      -- see that rate_limit_config row above).
      v_rate := public.check_rate_limit(
        p_function_name => CASE WHEN v_client_key IS NULL THEN 'register_partner_no_ip' ELSE 'register_partner' END,
        p_user_id       => v_client_key
      );
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
      END IF;

      -- (2) generous platform-wide ceiling -- the real abuse backstop.
      -- Refusal itself is real-time (this RAISE happens on every call, same
      -- as any other rate-limit check). D2 fix: the ALERT for this bucket
      -- is handled by supabase/functions/platform-health-check/index.ts's
      -- existing fireAlert() path (every 15 min, real Mailgun delivery +
      -- dedup), not by an insert from this function or from a standalone
      -- pg_cron reconciler -- see this migration's header comment "D2".
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

COMMIT;
