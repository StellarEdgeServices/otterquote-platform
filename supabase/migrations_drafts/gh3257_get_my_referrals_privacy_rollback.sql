-- STATUS (gh-1438, as of 2026-10-30T18:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3257_get_my_referrals_privacy
-- EVIDENCE: drafted 2026-10-30 under #3257. The body below is the forward body of gh3241_get_my_referrals_opt_out.sql (PR #3255 head e042a4a8) byte for byte; the proof runner checks its prosrc md5 and diffs the catalog against the pre-forward snapshot. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3257_get_my_referrals_privacy. Re-creates get_my_referrals() with the gh3241 body and grants.
-- WARNING: opted-out referrals show their progress status again, and job_value is returned again for every row.
-- To go back further (to the gh3217a body), run gh3241_get_my_referrals_opt_out_rollback.sql after this file.
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
    CASE WHEN o.opted_out THEN NULL ELSE m.display_name END AS display_name,
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
  CROSS JOIN LATERAL (
    -- gh-3241 / privacy.html 4.7: the homeowner declined updates to their referrer on any linked claim, or in the referral's
    -- metadata (send-partner-status-email's fallback source). The status stays; the name does not.
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
COMMIT;
