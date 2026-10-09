-- gh-2310 Gap 3: admin_list_referrals() gets the missing is_test predicate (row 5a of Docs/is-test-steering-queries.md).
-- STATUS (gh-1438): APPLIED. APPLIED to production (yeszghaspzwwstvsrioa) under R-097 by CTO RUN 64 (claim cto-2026-10-08T16:29:34Z): supabase_migrations.schema_migrations version 20261008210751, name gh2310_gap3_admin_list_referrals_is_test; evidence #2310 comment 6069081536. Replaces the body of an existing SECURITY DEFINER SQL function (same signature, same grants), additive in effect: it only hides rows.
-- Tier 3B by the CTO's ruling on #2310 (comment 6046227412) because it changes what the admin sees.
-- EVIDENCE: production body md5 9da71c08… (first 8 characters) (pg_get_functiondef, read-only 2026-10-07T20:28Z) equals sql/v98-admin-list-referrals.sql and the baseline migration body: no is_test anywhere.
-- Rollback: supabase/migrations_rollbacks/gh2310_gap3_admin_list_referrals_is_test_rollback.sql (restores that body byte for byte)
-- Test: tests/gh2310-static-admin-list-referrals.mjs (static, CI) and supabase/tests/gh2310_gap3_referrals_is_test_proof.sql (rolled back, human-run)
-- NEVER RE-RUN by hand: this is the filed copy under the ledger version (moved from supabase/migrations_drafts/ after the apply; SQL statements unchanged, header comments only).
--
-- What changes: one added predicate pair in WHERE. A referral is listed only if its own flag is not true AND its agent's flag is not true.
-- "IS NOT TRUE" keeps NULL-flag rows and keeps unattributed rows (referral_agent_id NULL => ra.* NULL), which the v98 header documents as the early-warning
-- signal for attribution regressions (#595). Nothing else changes: columns, ORDER BY, LIMIT 1000, the is_admin_email() gate, SECURITY DEFINER, search_path.
-- Grants are preserved by CREATE OR REPLACE; the probe below re-asserts them. The statements run in one transaction (BEGIN/COMMIT): if the probe raises, the body is not replaced.
-- Effect measured read-only 2026-10-07T20:28Z: rows visible to the admin 48 -> 10 (38 test rows hidden; 9 of them are the legacy rows of gh2310_gap3_backfill_referrals_is_test).

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_referrals()
 RETURNS TABLE(id uuid, created_at timestamp with time zone, status text, referral_agent_id uuid, partner_name text, partner_email text, partner_code text, homeowner_email text, landing_page text, job_value numeric, commission_amount numeric, recruit_commission_amount numeric, claim_id uuid, claim_completion_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    r.id,
    r.created_at,
    r.status,
    r.referral_agent_id,
    NULLIF(TRIM(COALESCE(ra.first_name,'') || ' ' || COALESCE(ra.last_name,'')), ''),
    ra.email,
    ra.unique_code,
    r.homeowner_email,
    r.landing_page,
    r.job_value,
    r.commission_amount,
    r.recruit_commission_amount,
    r.claim_id,
    c.completion_date
  FROM public.referrals r
  LEFT JOIN public.referral_agents ra ON ra.id = r.referral_agent_id
  LEFT JOIN public.claims          c  ON c.id  = r.claim_id
  WHERE public.is_admin_email()
    AND r.is_test  IS NOT TRUE     -- gh-2310 Gap 3: test click rows are not partner activity
    AND ra.is_test IS NOT TRUE     -- gh-2310 Gap 3: nor are rows under a test/staff agent (NULL ra = unattributed, still listed)
  ORDER BY r.created_at DESC
  LIMIT 1000;
$function$
;

-- Grants probe (Danger Pattern #9): anon must still be unable to execute; authenticated must still be able.
DO $probe$
BEGIN
  IF has_function_privilege('anon', 'public.admin_list_referrals()', 'EXECUTE') THEN
    RAISE EXCEPTION 'gh2310 gap3 SAFETY: anon has EXECUTE on admin_list_referrals()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_list_referrals()', 'EXECUTE') THEN
    RAISE EXCEPTION 'gh2310 gap3 SAFETY: authenticated lacks EXECUTE on admin_list_referrals()';
  END IF;
END
$probe$;

COMMIT;
