-- STATUS (gh-1438, as of 2026-10-30T18:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3257_get_my_referrals_privacy (pre-flight is gh3257_get_my_referrals_privacy_pre-flight.md)
-- EVIDENCE: drafted 2026-10-30 under #3257. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): get_my_referrals() is still the gh3217a body (md5(prosrc) = e63684bf6ce7d5b2da454ee00b31a9e9), i.e. gh3241 (PR #3255) is NOT applied yet; referrals.status is NOT NULL DEFAULT 'clicked' with 0 NULL rows; 1 referral has a job_value; 0 referrals are linked to an opted-out claim. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3257_get_my_referrals_privacy
-- GitHub: #3257 (Dustin's ruling "Match the policy (Recommended)", 2026-10-30). Project P18. R-134 protective-only.
-- APPLY ORDER: AFTER gh3241_get_my_referrals_opt_out (PR #3255). The pre-flight md5 guard refuses any other starting body.
-- Rollback: gh3257_get_my_referrals_privacy_rollback.sql (restores the gh3241 body exactly)
-- Proof: bash supabase/tests/gh3257_get_my_referrals_privacy_proof_run.sh --mutations (throwaway Postgres only)
--
-- privacy.html 4.7 lets a referred homeowner "decline these updates" and says the updates "never include your claim amount".
-- On top of gh3241 (display_name NULL for an opted-out referral):
--   1. status is NULL for an opted-out referral. referrals.status is NOT NULL DEFAULT 'clicked', so a NULL status in this
--      result means exactly "updates declined"; the dashboards use that to render "Referral #N — updates declined".
--   2. job_value is NULL for EVERY row. The column is kept (NULL::numeric) rather than dropped: dropping it changes the
--      RETURNS TABLE type, which CREATE OR REPLACE cannot do, so it would need DROP FUNCTION + CREATE (grants recreated, a
--      window where the function does not exist, and any deployed client that still names the column breaks). Keeping it
--      lets CREATE OR REPLACE keep the ACL and makes this a body-only change with an exact rollback.
--   3. The partner's own fee fields (commission_amount, commission_paid_at, recruit_commission_amount, recruit_paid_at) are
--      unchanged for every row, opted out or not: the partner needs them for payment.
-- Same signature, return type, SECURITY DEFINER and search_path; the REVOKE/GRANT pair is restated so a re-run changes nothing.

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
    CASE WHEN o.opted_out THEN NULL ELSE r.status END AS status,
    r.created_at,
    CASE WHEN o.opted_out THEN NULL ELSE m.display_name END AS display_name,
    NULL::numeric AS job_value,
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
  CROSS JOIN LATERAL (
    -- gh-3241 / privacy.html 4.7: the homeowner declined updates to their referrer on any linked claim, or in the referral's
    -- metadata (send-partner-status-email's fallback source). gh-3257: neither the name nor the status is returned for it.
    SELECT (
      EXISTS (SELECT 1 FROM public.claims c WHERE c.referral_id = r.id AND c.referrer_updates_opt_out IS TRUE)
      OR EXISTS (SELECT 1 FROM public.claims c WHERE c.id = r.claim_id AND c.referrer_updates_opt_out IS TRUE)
      OR coalesce(r.metadata -> 'referrer_updates_opt_out' = 'true'::jsonb, false)
    ) AS opted_out
  ) o
  WHERE r.referral_agent_id IN (
    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()
  )
  ORDER BY r.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_my_referrals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_referrals() TO authenticated, service_role;
