-- Rollback for: 20260818214620_gh972_get_contractor_quote_claim_ids_auth_scope.sql
-- GitHub: #972
-- WARNING: restores the PRE-FIX vulnerable behavior - caller-supplied
-- p_user_id scoping and anon EXECUTE (claim-ID enumeration). Only run to
-- revert an unexpected regression; re-apply the fix ASAP after rollback.

CREATE OR REPLACE FUNCTION public.get_contractor_quote_claim_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT q.claim_id FROM quotes q JOIN contractors c ON c.id = q.contractor_id WHERE c.user_id = p_user_id;
$function$;

COMMENT ON FUNCTION public.get_contractor_quote_claim_ids(uuid) IS NULL;

GRANT EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) TO anon;
