-- STATUS (gh-1438, as of 2026-10-30T16:30:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3241_get_my_referrals_opt_out (pre-flight is gh3241_get_my_referrals_opt_out_pre-flight.md)
-- EVIDENCE: drafted 2026-10-30 under #3241. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): get_my_referrals() is live with the body of supabase/migrations_drafts/gh3217a_get_my_referrals.sql byte for byte (md5(prosrc) = e63684bf6ce7d5b2da454ee00b31a9e9, 1164 chars), proacl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}, and does not read claims.referrer_updates_opt_out. claims.referrer_updates_opt_out is boolean, nullable, no default; 3 claims are opted out (all is_test=false) and 0 referrals are linked to an opted-out claim by either claims.referral_id or referrals.claim_id. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3241_get_my_referrals_opt_out
-- GitHub: #3241 (follow-up (b) of Ben's R-177 SIGNED on #3225, 6524259012). Project P18. R-134 protective-only.
-- Rollback: gh3241_get_my_referrals_opt_out_rollback.sql (restores the live body exactly)
-- Proof: bash supabase/tests/gh3241_get_my_referrals_opt_out_proof_run.sh --mutations (throwaway Postgres only)
--
-- privacy.html 4.7 lets a homeowner decline updates to the person who referred them (claims.referrer_updates_opt_out).
-- get_my_referrals() now returns display_name = NULL for a referral whose homeowner opted out. The row itself, its status
-- and the partner's own commission fields are unchanged (the partner still tracks what they are owed); display_name is the
-- only field of the result that identifies the homeowner. A referral counts as opted out when ANY linked claim says so
-- (linked from either side: claims.referral_id = r.id or r.claim_id = claims.id) or when referrals.metadata carries
-- referrer_updates_opt_out = true -- the same sources send-partner-status-email honours. NULL ("never asked") is not an
-- opt-out here: the name keeps showing, as today.
-- Same signature, return type, SECURITY DEFINER and search_path as the live function, so CREATE OR REPLACE keeps its ACL;
-- the REVOKE/GRANT pair is restated anyway so the file is correct on its own and a re-run changes nothing.
-- No new wording: the dashboards already render their missing-name text for a NULL display_name.

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
