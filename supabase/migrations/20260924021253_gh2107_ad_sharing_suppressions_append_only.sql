-- gh-2107: make public.ad_sharing_suppressions APPEND-ONLY for the service role.
-- Owed by Ben's R-177 SIGNED on the table's PR (#2133, comment 5806201431): "REVOKE UPDATE, DELETE and TRUNCATE on
-- ad_sharing_suppressions from service_role, so the table stays append-only." (The REVIEW, 5806174399 N1, found that
-- Supabase's default privileges GRANT ALL on a new public table to service_role, so the `GRANT SELECT, INSERT` in
-- 20260924015735 adds to that rather than narrowing it, and "a row is never overwritten" rested only on the primary key.)
-- Tier 3A under D-261: it only REMOVES privileges from one role on one table; no data, no schema, no other role changes.
--
-- WHY. A row here is a person's recorded opt-out from advertising sharing (compliance evidence, and "cannot be added
-- retroactively"). The only writer is the admin support-email Edge Function, which inserts with ON CONFLICT DO NOTHING; the only
-- reader is the CAPI send. Neither ever updates, deletes or truncates. Removing those privileges makes a bug or a compromised
-- service key unable to erase an opt-out through the API. Removing a row for a verified opt-BACK-in remains possible for the
-- table owner (the postgres role), deliberately, in the open.
--
-- WHAT IS KEPT: SELECT and INSERT for service_role (the only two privileges the writer and the CAPI check use). ON CONFLICT DO
-- NOTHING needs INSERT only.
--
-- Companion rollback: supabase/migrations_rollbacks/20260924021253_gh2107_ad_sharing_suppressions_append_only_rollback.sql
-- ORDER: apply AFTER 20260924015735_gh2107_ad_sharing_suppressions.sql (PR #2133); this file fails loudly if the table is absent.

BEGIN;

DO $mig$
BEGIN
  IF to_regclass('public.ad_sharing_suppressions') IS NULL THEN
    RAISE EXCEPTION 'gh2107 append-only migration: public.ad_sharing_suppressions does not exist; apply 20260924015735_gh2107_ad_sharing_suppressions.sql first';
  END IF;
END
$mig$;

REVOKE UPDATE, DELETE, TRUNCATE ON public.ad_sharing_suppressions FROM service_role;

COMMIT;

-- =============================================================================
-- ROLLBACK lives in supabase/migrations_rollbacks/ (NOT here: a file in this directory would be applied by the Supabase
-- runner as a migration).
-- =============================================================================
