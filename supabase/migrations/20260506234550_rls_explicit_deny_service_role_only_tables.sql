-- Migration: rls_explicit_deny_service_role_only_tables
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-06T23:45:50Z, recorded in
-- supabase_migrations.schema_migrations as version 20260506234550, name
-- "rls_explicit_deny_service_role_only_tables". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.


-- Explicit deny policies for service-role-only tables.
-- These tables are accessed exclusively via service_role key (bypasses RLS).
-- Policies make the intent explicit and silence the Supabase security advisor.

-- hover_tokens: HOVER OAuth credentials, no Supabase user ID, never client-accessible
CREATE POLICY "hover_tokens_deny_all"
  ON public.hover_tokens
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false);

-- imported_hover_jobs: internal outreach operations table with homeowner PII, no user ID
CREATE POLICY "imported_hover_jobs_deny_all"
  ON public.imported_hover_jobs
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false);

-- support_tickets: inbound email processing table (Mailgun → AI → admin workflow)
-- If a user-facing "my tickets" view is added later, replace with scoped read policy
CREATE POLICY "support_tickets_deny_all"
  ON public.support_tickets
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false);
