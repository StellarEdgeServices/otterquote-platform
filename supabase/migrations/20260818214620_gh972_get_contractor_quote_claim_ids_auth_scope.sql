-- gh-972: get_contractor_quote_claim_ids(p_user_id) took a caller-supplied
-- user_id instead of scoping to auth.uid() - claim-ID enumeration via
-- anon EXECUTE. D-182 approved by Dustin 2026-08-18 ("APPROVE ALL 7").
-- Applied live via Supabase MCP; this file is the git record.
--
-- p_user_id parameter is kept (for RLS-policy call-site compatibility:
-- public.claims "Contractors can view claims for their quotes" already
-- calls this with auth.uid() as its sole argument) but is now IGNORED -
-- scope is always auth.uid() internally.
--
-- Fixed live during verification: the drafted package revoked EXECUTE
-- FROM anon but not FROM PUBLIC, and anon is an implicit PUBLIC member -
-- the bare `=X/postgres` ACL entry still granted anon EXECUTE regardless
-- of the explicit revoke (the same PUBLIC-grant trap #970's own package
-- correctly guarded against for its 6 functions, memory
-- `supabase-function-grant-defaults`). This migration includes the
-- corrected REVOKE ... FROM PUBLIC.

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

REVOKE EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) FROM anon;
