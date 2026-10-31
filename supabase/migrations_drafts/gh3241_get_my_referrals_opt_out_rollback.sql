-- STATUS (gh-1438, as of 2026-10-30T16:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3241_get_my_referrals_opt_out
-- EVIDENCE: drafted 2026-10-30 under #3241. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): get_my_referrals() is live with the body of supabase/migrations_drafts/gh3217a_get_my_referrals.sql byte for byte (md5(prosrc) = e63684bf6ce7d5b2da454ee00b31a9e9, 1164 chars), proacl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}, and does not read claims.referrer_updates_opt_out. claims.referrer_updates_opt_out is boolean, nullable, no default; 3 claims are opted out (all is_test=false) and 0 referrals are linked to an opted-out claim by either claims.referral_id or referrals.claim_id. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3241_get_my_referrals_opt_out. Re-creates get_my_referrals() with the live body read 2026-10-30 (identical to
-- gh3217a_get_my_referrals.sql; md5(prosrc) = e63684bf6ce7d5b2da454ee00b31a9e9) and the live grants. The proof runner checks the
-- prosrc md5 and diffs the catalog against the pre-forward snapshot. WARNING: opted-out homeowners' names show to referrers again.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_my_referrals()
RETURNS TABLE(
  id                        uuid,
  status                    text,
  created_at                timestamptz,
  display_name              text,
  job_value                 numeric,
  commission_amount         numeric,
  commission_paid_at        timestamptz,
  recruit_commission_amount numeric,
  recruit_paid_at           timestamptz,
  is_test                   boolean,
  referral_agent_id         uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    r.id,
    r.status,
    r.created_at,
    m.display_name,
    r.job_value,
    r.commission_amount,
    r.commission_paid_at,
    r.recruit_commission_amount,
    r.recruit_paid_at,
    r.is_test,
    r.referral_agent_id
  FROM public.referrals r
  CROSS JOIN LATERAL (
    -- privacy.html 4.7: "first name and last initial only". A name containing '@' or a digit (an email or phone typed into the
    -- name field) is not shown at all. One word: that word. Two or more: first word + initial of the last word.
    SELECT CASE
      WHEN nullif(btrim(r.homeowner_name), '') IS NULL THEN NULL
      WHEN r.homeowner_name ~ '[@0-9]' THEN NULL
      WHEN btrim(r.homeowner_name) !~ '\s' THEN left(btrim(r.homeowner_name), 40)
      ELSE left((regexp_split_to_array(btrim(r.homeowner_name), '\s+'))[1], 40) || ' ' ||
           upper(left((regexp_split_to_array(btrim(r.homeowner_name), '\s+'))[array_length(regexp_split_to_array(btrim(r.homeowner_name), '\s+'), 1)], 1)) || '.'
    END AS display_name
  ) m
  WHERE r.referral_agent_id IN (
    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()
  )
  ORDER BY r.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_my_referrals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_referrals() TO authenticated, service_role;
COMMIT;
