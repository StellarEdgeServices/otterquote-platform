-- Rollback for: 20260924021253_gh2107_ad_sharing_suppressions_append_only.sql
-- GitHub: #2107 (gh-2107 / D-330 half 2)
-- Restores UPDATE, DELETE and TRUNCATE to service_role on public.ad_sharing_suppressions, i.e. the privileges Supabase's default
-- ACL grants, so the table is again editable and erasable through the API by the service key. This WEAKENS the protection of a
-- compliance record; run it only deliberately. Safe to run twice; a no-op if the table does not exist.

BEGIN;

DO $rb$
BEGIN
  IF to_regclass('public.ad_sharing_suppressions') IS NOT NULL THEN
    EXECUTE 'GRANT UPDATE, DELETE, TRUNCATE ON public.ad_sharing_suppressions TO service_role';
  END IF;
END
$rb$;

COMMIT;
