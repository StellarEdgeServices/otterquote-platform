-- Migration: 20260819224323_v113b_resolved_user_role_grant_hardening
-- Author: Claude Code (automated, run-work rw-909-f22-b4vw)
-- Date: 2026-08-19
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: 20260819224323_v113b_resolved_user_role_grant_hardening_rollback.sql
--
-- gh-1307 (2026-08-27): this file did not exist in the repo at all -- it was
-- applied directly to production (schema_migrations version 20260819224323,
-- immediately after v113 at 20260819224215) but the .sql was never
-- committed. Backfilled here verbatim from `statements` in
-- supabase_migrations.schema_migrations so the repo matches what actually
-- ran. Re-verified 2026-08-27: information_schema.role_table_grants for
-- public.resolved_user_role shows exactly one grant for a non-owner role
-- (authenticated: SELECT), matching this file's intent -- no drift.
--
-- v113's REVOKE ALL FROM PUBLIC / FROM anon did not strip the
-- default-ACL-granted ALL privileges directly held by `authenticated` on
-- public.resolved_user_role (same class of trap as the v95a referral-RPC
-- grant-default lesson, applied here to a view instead of a function).
-- View is not updatable (CTEs), so INSERT/UPDATE/DELETE grants were not
-- currently exploitable, but this brings live grants in line with the
-- migration's documented "authenticated: SELECT only" security model.
BEGIN;

REVOKE ALL ON public.resolved_user_role FROM authenticated;
GRANT SELECT ON public.resolved_user_role TO authenticated;

COMMIT;
