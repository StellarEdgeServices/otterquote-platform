-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED
-- FILE ROLE: forward file of set gh1026_drop_admin_contractor_last_logins (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: the DROP VIEW has not run (view still exists; authenticated SELECT already revoked live): comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); comment 5850997376 (CLOSE-REVIEW 2026-09-26). Not re-measured since; re-query the live ledger before relying on it.
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh1026_drop_admin_contractor_last_logins
-- Author: Code lane sub-agent (automated), run-work orchestration
-- Date: 2026-08-21
-- Status: DRAFT ONLY — Tier 3B (destructive DDL, treated conservatively even
--         though the object is empty-by-design and has zero consumers).
--         NOT APPLIED. No apply_migration call was made against production
--         to produce this file. R-097 24h notice posted on #1026 and
--         cross-posted to #1206 with a real stamp.py timestamp.
-- Rollback: gh1026_drop_admin_contractor_last_logins_rollback.sql
-- Pre-flight: gh1026_drop_admin_contractor_last_logins_pre-flight.md
-- GitHub: #1026
--
-- Summary: public.admin_contractor_last_logins is NOT a table that a
-- trigger/cron/Edge Function ever needed to populate — it is a VIEW
-- (created by sql/v41-admin-last-login-view.sql, Session 191), gated by a
-- WHERE clause on auth.email(). It computes live from contractors JOIN
-- auth.users; there was never a "writer" for it to lack. It was
-- superseded by the SECURITY DEFINER RPC public.get_contractor_last_logins()
-- (Session 349 security fix, ref 86e11fa1g) — the RPC does the identical
-- join, with the safer SECURITY DEFINER + RAISE EXCEPTION gate instead of
-- a WHERE-clause filter that fails silently to zero rows. The view's SELECT
-- grant for `authenticated` has already been revoked live (verified this
-- session via information_schema.role_table_grants: only service_role and
-- postgres retain SELECT) — the view is already effectively decommissioned
-- in production; this migration just removes the dead object. Zero code
-- consumers found in a full-repo grep (HTML/JS/TS/React, Edge Functions,
-- migrations, docs, and Claude's Memories) — the sole historical caller,
-- admin-incomplete-profiles.html, was migrated to the RPC and its inline
-- comment documents the view as already revoked.

BEGIN;

DROP VIEW IF EXISTS public.admin_contractor_last_logins;

COMMIT;
