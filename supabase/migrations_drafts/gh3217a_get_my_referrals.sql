-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- FILE ROLE: forward file, PART A of set gh3217_mask_referral_homeowner (additive; pre-flight is gh3217_mask_referral_homeowner_pre-flight.md)
-- EVIDENCE: drafted 2026-10-30 under #3217. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): policy "Agents can read own referrals" (SELECT, roles={public}) returns whole rows to the signed-in partner; relacl = {postgres=arwdDxtm/postgres,anon=rwdDxtm/postgres,authenticated=rwdDxtm/postgres,service_role=arwdDxtm/postgres} (table-level SELECT, no column ACLs); get_my_referrals() absent; admin_list_referrals() is SECURITY DEFINER. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3217a_get_my_referrals  (PART A, additive, apply FIRST)
-- GitHub: #3217. Project P18. R-134 protective-only. Creates get_my_referrals() only; removes nothing, so the live dashboards keep working.
-- Apply order: A -> merge/deploy frontend -> smoke test -> B (gh3217b_referrals_column_allowlist.sql).
-- Rollback: gh3217a_get_my_referrals_rollback.sql (use only BEFORE the frontend deploys)
-- Proof: supabase/tests/gh3217_mask_referral_homeowner_proof.sql

-- Masked read for the signed-in referrer. Returns no email, phone, address or city.
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
