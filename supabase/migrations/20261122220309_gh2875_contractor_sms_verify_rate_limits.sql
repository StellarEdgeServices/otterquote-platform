-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED
-- FILE ROLE: forward file of set gh2875_contractor_sms_verify_rate_limits (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-23 under #2875. Production read-only (Supabase MCP execute_sql, SELECT only) 2026-10-23T22:1xZ:
--   public.rate_limit_config has NO contractor-sms-verify-start / contractor-sms-verify-check row (0 rows LIKE 'contractor-sms-verify%');
--   public.rate_limits has 0 rows for those names; check_rate_limit(text,uuid) md5(pg_get_functiondef) = 905e1e5378a90834 (first 16 hex).
--   No database was written to produce this file.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2875_contractor_sms_verify_rate_limits
-- GitHub: #2875 (D-391 layer 2). The two rate_limit_config rows contractor-sms-verify needs. Without them check_rate_limit() denies
--   every call ("No rate limit config found ... Denying by default."), so the function answers 429 rate_limited to everyone.
-- Rollback: supabase/migrations_drafts/gh2875_contractor_sms_verify_rate_limits_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2875_contractor_sms_verify_rate_limits_pre-flight.md
-- Proof: bash supabase/tests/gh2875_contractor_sms_verify_rate_limits_proof_run.sh (throwaway Postgres; never production)
--
-- Keys, from supabase/functions/contractor-sms-verify/handler.ts at c7162ab60f422ee0 (main, #3043 merge):
--   L32 RL_START = "contractor-sms-verify-start"   (action "start": asks Twilio Verify to text a code)
--   L33 RL_CHECK = "contractor-sms-verify-check"   (action "check": asks Twilio Verify whether the code is right; sends nothing)
--   L239-244: each request calls check_rate_limit(<key>, bucket) TWICE, bucket = user.id, then bucketUuid("phone", phone)
--   (L104-105, sha256 of "contractor-sms-verify:phone:<E.164>"). Both buckets share ONE row per key, so the limits below apply to
--   each signed-in account AND to each phone number separately. index.ts L44-47: allowed only when data.allowed === true.
-- Windows are not chosen here: check_rate_limit() counts rolling 1 hour / 1 day / 1 month per caller_id, and the budget cap counts
--   every non-blocked row for the function name across ALL callers (live definition, md5 above; baseline file line 1359).
--
-- Limits (a judgment call, not traffic-validated; raise with an UPDATE if legitimate contractors are throttled):
--   start 5/hour, 10/day, 30/month per bucket. 5/hour matches the 6-digit / 10-minute / 5-attempt Verify spec (#2875 spec headline):
--     one code lives 10 minutes, so 5 sends an hour is a code, a resend and three retries. A contractor verifies one to a few numbers.
--     The tight day and month caps bound how many code texts one account can push at arbitrary numbers (REVIEW 6323770893), and bound
--     the per-number "burn": any signed-in owner can spend another number's bucket (REVIEW 6323770893, 6323942779). A burn locks that
--     number for at most 1 hour (5 starts), 1 day (10) or a rolling month (30 starts, which also spends the burner's own whole month).
--   start cost 0.0292 per row, cap 10.00 per month (global, all callers): one send writes 2 allowed rows (account + number bucket),
--     so 0.0292 = ($0.05 Verify success fee + $0.0083 US SMS) / 2, rounded up to numeric(10,4). Conservative: the success fee is billed
--     only on an approved check. The cap denies new sends at 343 rows (343 * 0.0292 = 10.0156 >= 10.00), about 171 code texts a month.
--     Same shape as the send-sms row (0.0079 / 4.00).
--   check 10/hour, 30/day, 100/month per bucket, cost 0, no budget cap (a check texts nobody). Twilio itself allows 5 checks per code
--     and answers 429 after that (handler.ts L264-266 maps it to too_many_attempts); 10/hour is two codes' worth of typos.
-- Additive (Tier 3A in shape): one INSERT ... ON CONFLICT (function_name) DO NOTHING, no DDL, no GRANT, no RLS change.
-- Idempotent: a second run inserts nothing, and a row that already exists (for example tuned by hand) is left exactly as it is.
-- DEPLOY ORDER: apply before, or together with, the first deploy of contractor-sms-verify. Until it is applied the function fails
--   closed (429 rate_limited for everyone), which is the safe direction.

BEGIN;

DO $gate$
BEGIN
  IF to_regclass('public.rate_limit_config') IS NULL OR to_regclass('public.rate_limits') IS NULL THEN
    RAISE EXCEPTION 'gh2875 rate-limit gate: public.rate_limit_config / public.rate_limits missing';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh2875 rate-limit gate: public.check_rate_limit(text,uuid) missing';
  END IF;
END
$gate$;

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('contractor-sms-verify-start', 5, 10, 30, true, 0.0292, 10.00,
   'gh2875 D-391 layer 2: Twilio Verify code send (action start). Checked twice per request: once on the account bucket (auth user id) and once on the number bucket (sha256 of "contractor-sms-verify:phone:<E.164>"), so these limits apply per account AND per number, and one send writes 2 allowed rows. Cost/row = ($0.05 Verify success fee + $0.0083 SMS)/2; $10/mo global cap is about 171 sends. Judgment call, not traffic-validated.'),
  ('contractor-sms-verify-check', 10, 30, 100, true, 0.0000, 0.00,
   'gh2875 D-391 layer 2: Twilio Verify code check (action check). Sends nothing; Twilio itself caps 5 checks per code. Same two buckets (account and number). Judgment call, not traffic-validated.')
ON CONFLICT (function_name) DO NOTHING;

DO $report$
DECLARE r record;
BEGIN
  FOR r IN SELECT function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap
             FROM public.rate_limit_config
            WHERE function_name IN ('contractor-sms-verify-start', 'contractor-sms-verify-check')
  LOOP
    IF (r.function_name = 'contractor-sms-verify-start'
          AND (r.max_per_hour, r.max_per_day, r.max_per_month, r.enabled, r.monthly_cost_estimate, r.monthly_budget_cap)
              IS DISTINCT FROM (5, 10, 30, true, 0.0292::numeric, 10.00::numeric))
       OR (r.function_name = 'contractor-sms-verify-check'
          AND (r.max_per_hour, r.max_per_day, r.max_per_month, r.enabled, r.monthly_cost_estimate, r.monthly_budget_cap)
              IS DISTINCT FROM (10, 30, 100, true, 0.0000::numeric, 0.00::numeric)) THEN
      RAISE NOTICE 'gh2875: % already existed with other values; left unchanged (ON CONFLICT DO NOTHING)', r.function_name;
    END IF;
  END LOOP;
END
$report$;

COMMIT;
