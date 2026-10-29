-- STATUS (gh-1438, as of 2026-10-29): NOT APPLIED
-- FILE ROLE: rollback file of set gh3077_last_logins_is_admin_email (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-29 (CTO RUN 87, tid cto87-b3077) under #3077; live definition read via SELECT pg_get_functiondef (read-only) the same day. No apply_migration was made.
-- REPO COPY: none in supabase/migrations/
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3077_last_logins_is_admin_email_rollback.sql
-- Reverts: gh3077_last_logins_is_admin_email.sql
-- Restores the production body byte-for-byte as returned by pg_get_functiondef on 2026-10-29
-- (yeszghaspzwwstvsrioa); the statement below is that output plus the closing semicolon.
-- Grants are left as the forward file set them (postgres, authenticated, service_role; none for anon/PUBLIC),
-- which equals the live ACL before the forward ran: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_contractor_last_logins()
 RETURNS TABLE(contractor_id uuid, last_sign_in_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.email() IS DISTINCT FROM 'dustinstohler1@gmail.com' THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT c.id AS contractor_id, u.last_sign_in_at
  FROM contractors c
  LEFT JOIN auth.users u ON c.user_id = u.id;
END;
$function$;

COMMIT;
