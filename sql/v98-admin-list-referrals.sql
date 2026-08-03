-- ============================================================================
-- v98 — Admin referral visibility RPC  (GitHub #599)
-- ============================================================================
--
-- PROBLEM
--   admin-referrals.html is the designated admin surface for referral
--   attribution, but it only ever queries referral_agents — it never reads the
--   referrals table. There is no admin view of referral records anywhere on
--   the platform.
--
--   Simply pointing the page at `referrals` would not work: referrals has no
--   admin SELECT policy. Its policies are:
--     "Service role full access"                ALL     auth.role() = service_role
--     "Public can insert referral clicks"       INSERT
--     "Agents can read own referrals"           SELECT  (own agent rows only)
--     "Authenticated can advance referral status" UPDATE
--   An admin's authenticated JWT matches none of them, so a client-side read
--   returns 0 rows — silently.
--
-- WHY AN RPC AND NOT A POLICY
--   Adding an admin SELECT policy to referrals would be an RLS change, which
--   D-182 (as amended by D-261) classifies as Tier 3B — requiring a 24-hour
--   R-097 risk brief. A new SECURITY DEFINER function is additive (Tier 3A,
--   autonomous) and matches the established v95 pattern. The function
--   self-gates on is_admin_email(), the same predicate the referral_agents
--   admin policy already uses, so the authorisation surface is unchanged.
--
-- TIER: 3A (additive — new function only; no schema change, no RLS change).
--
-- GRANTS: migration-author Danger Pattern #9 — explicit per-role REVOKE +
--   GRANT with a negative probe. anon must never reach this.
--
-- Rollback: sql/v98-rollback-admin-list-referrals.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_referrals()
RETURNS TABLE (
  id                        uuid,
  created_at                timestamptz,
  status                    text,
  referral_agent_id         uuid,
  partner_name              text,
  partner_email             text,
  partner_code              text,
  homeowner_email           text,
  landing_page              text,
  job_value                 numeric,
  commission_amount         numeric,
  recruit_commission_amount numeric,
  claim_id                  uuid,
  claim_completion_date     timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
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
  WHERE public.is_admin_email()      -- non-admins get zero rows, never an error
  ORDER BY r.created_at DESC
  LIMIT 1000;
$function$;

COMMENT ON FUNCTION public.admin_list_referrals() IS
'#599: admin-only read of the referrals table joined to referral_agents and claims, for admin-referrals.html. referrals has no admin SELECT policy, so a client-side read returns 0 rows silently; this SECURITY DEFINER function self-gates on is_admin_email() instead of widening RLS (which would be Tier 3B). Rows with referral_agent_id NULL surface as Unattributed — the early-warning signal for attribution regressions like #595. authenticated EXECUTE only; anon explicitly revoked per Danger Pattern #9.';

-- ── Grants (Danger Pattern #9) ───────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_list_referrals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_referrals() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_referrals() TO authenticated;

-- ── Negative probe — fail the migration if anon can execute ──────────────────
DO $probe$
BEGIN
  IF has_function_privilege('anon', 'public.admin_list_referrals()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v98 SAFETY: anon has EXECUTE on admin_list_referrals() — aborting';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_list_referrals()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v98 SAFETY: authenticated lacks EXECUTE on admin_list_referrals() — aborting';
  END IF;
END
$probe$;

COMMIT;
