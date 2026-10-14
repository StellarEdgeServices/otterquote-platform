CREATE OR REPLACE FUNCTION public.get_contractor_quote_claim_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT q.claim_id
  FROM quotes q
  JOIN contractors c ON c.id = q.contractor_id
  WHERE c.user_id = auth.uid();
$function$;

COMMENT ON FUNCTION public.get_contractor_quote_claim_ids(uuid) IS
  'gh972: p_user_id parameter retained ONLY for RLS-policy call-site compatibility (public.claims "Contractors can view claims for their quotes") and is IGNORED - scope is always auth.uid(). Do not reintroduce caller-supplied scoping.';

REVOKE EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) FROM anon;
