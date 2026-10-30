-- STATUS (gh-1438, as of 2026-10-30T12:30:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3217_mask_referral_homeowner (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3217. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): policy "Agents can read own referrals" (SELECT, roles={public}) lets a signed-in partner read whole rows of their referrals; relacl = {postgres=arwdDxtm, anon=rwdDxtm, authenticated=rwdDxtm, service_role=arwdDxtm} (table-level SELECT, no column-level ACLs: pg_attribute.attacl empty); get_my_referrals() absent; admin_list_referrals() is SECURITY DEFINER and is what admin-referrals.html calls. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3217_mask_referral_homeowner
-- GitHub: #3217. Project P18. Tier 3B (RLS/grant change). R-134 protective-only: removes partner access to homeowner contact data.
-- Rollback: gh3217_mask_referral_homeowner_rollback.sql   Pre-flight: gh3217_mask_referral_homeowner_pre-flight.md
-- Proof: supabase/tests/gh3217_mask_referral_homeowner_proof.sql
--
-- WHY COLUMN PRIVILEGES AND NOT A POLICY CHANGE
--   RLS is row-level: no policy can hide homeowner_email while still returning the same row. Live, `authenticated` holds a TABLE-level
--   SELECT, and a table-level grant overrides any column REVOKE, so `REVOKE SELECT (homeowner_email) ...` alone is a no-op. The change
--   therefore revokes the table-level SELECT and re-grants SELECT on an explicit allow-list of non-contact columns. The allow-list is
--   exactly what the dashboards still read directly (stats and recruit earnings); contact columns, and `metadata`, are withheld, and a
--   column added later is private by default. The RLS policy is left untouched, so it still scopes rows. Dropping the policy instead
--   would also break those stat reads and would leave the contact columns exposed to any policy added later.
--   Partner / customer-referrer lists read through get_my_referrals(), which masks the name. service_role and SECURITY DEFINER
--   functions (admin_list_referrals, edge functions) are unaffected.

-- 1. Masked read for the signed-in referrer. Returns no email, phone, address or city.
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

-- 2. Withdraw direct read of the contact columns (and metadata) from client roles.
REVOKE SELECT ON public.referrals FROM anon, authenticated;
GRANT SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)
  ON public.referrals TO authenticated;
