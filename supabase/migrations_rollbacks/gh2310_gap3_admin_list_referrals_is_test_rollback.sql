-- Rollback for gh2310_gap3_admin_list_referrals_is_test (draft in supabase/migrations_drafts/).
-- Restores the production body of admin_list_referrals() byte for byte: pg_get_functiondef md5 9da71c089260f3d04dca3767568e03a2 (read 2026-10-07T20:28Z).
-- After it runs the admin Referrals table lists test rows again (the pre-fix behaviour). Never move into supabase/migrations/ (the CLI would replay it forward).
-- Grants are untouched by CREATE OR REPLACE.

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
  ORDER BY r.created_at DESC
  LIMIT 1000;
$function$
;
