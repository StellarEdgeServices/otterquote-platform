-- STATUS (gh-1438, as of 2026-10-29): NOT APPLIED
-- FILE ROLE: forward file of set gh3077_last_logins_is_admin_email (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-29 (CTO RUN 87, tid cto87-b3077) under #3077; live definition read via SELECT pg_get_functiondef (read-only) the same day. No apply_migration was made.
-- REPO COPY: none in supabase/migrations/
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3077_last_logins_is_admin_email
-- Tier 3B (auth gate on a SECURITY DEFINER function). DRAFT ONLY. Needs R-097 notice + recorded apply.
-- Rollback: supabase/migrations_rollbacks/gh3077_last_logins_is_admin_email_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3077_last_logins_is_admin_email_pre-flight.md
-- GitHub: #3077. Ruling: Ben 6478566612 ("move get_contractor_last_logins to is_admin_email()").
--
-- Before: the function authorizes with auth.email() IS DISTINCT FROM '<primary admin email>' (a literal).
-- After:  it authorizes with NOT public.is_admin_email(), so who may call it is the same single source as
--         every other admin check. is_admin_email() reads auth.jwt() ->> 'email', which is the caller's
--         JWT also inside a SECURITY DEFINER body (JWT claims are a session GUC, not the definer role).
-- Access effect (ruled, intended): the second admin address (and whatever #3009's admin_emails holds) may now
--         call it. NULL email / anon -> is_admin_email() is NULL -> COALESCE(...,false) -> 'Access denied'.
-- Unchanged: SECURITY DEFINER, SET search_path TO 'public', return type, body query, EXECUTE grants for
--         postgres / authenticated / service_role. Only the two authorization lines change.
-- Added: explicit REVOKE ... FROM PUBLIC, anon (live ACL already has neither; this pins it).
--        CREATE OR REPLACE keeps existing grants, so the GRANTs are restated for the record.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_contractor_last_logins()
 RETURNS TABLE(contractor_id uuid, last_sign_in_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT COALESCE(public.is_admin_email(), false) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT c.id AS contractor_id, u.last_sign_in_at
  FROM contractors c
  LEFT JOIN auth.users u ON c.user_id = u.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_contractor_last_logins() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_contractor_last_logins() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_contractor_last_logins() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_contractor_last_logins() TO service_role;

COMMIT;
