-- Migration: gh2010_leads_authenticated_insert
-- Issue: #2010 -- "[FRONT DOOR] /start Step 1 fails for any SIGNED-IN
--        visitor -- leads INSERT policy is TO anon only"
-- Tier: 3b (D-182/D-261). 24h notice window WAIVED by Dustin, verbatim
--        "Go on 2010." (issue comment 5720578332, 2026-09-17T20:10:35Z).
--        Authorized narrowly by Ben, CEO RUN 50, claim
--        ceo-2026-09-17T20:25:00Z (issue comment 5720783144,
--        2026-09-17T20:27:58Z): "the public.leads INSERT policy change
--        described in Ask item 1 ... It authorises no other RLS change,
--        on this table or any other."
-- Applied to production (yeszghaspzwwstvsrioa) 2026-09-17 via
--   supabase_migrations.schema_migrations version 20260917203831
--   (this file's on-disk timestamp prefix matches that applied version).
-- Rollback:  supabase/migrations_drafts/gh2010_leads_authenticated_insert_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2010_leads_authenticated_insert_pre-flight.md
--
-- Root cause (measured live against production, 2026-09-17, this run --
-- pg_policy for public.leads before this migration):
--   {Allow anonymous inserts, cmd=a, permissive=true, roles={anon},       with_check=true}
--   {leads_admin_select,      cmd=r, permissive=true, roles={authenticated}, using=is_admin_email()}
-- `public.leads` has exactly one INSERT policy, scoped TO anon only. The
-- `authenticated` role holds the INSERT GRANT (from an earlier migration)
-- but no INSERT POLICY, so RLS rejects every insert attempted by a
-- signed-in session on /start (42501 "new row violates row-level security
-- policy for table \"leads\"") -- confirmed reproducible both through the
-- real /start form and directly via supabase-js in-page (issue #2010 body).
--
-- Fix: widen the existing "Allow anonymous inserts" policy's role list to
-- include `authenticated`, rather than adding a second INSERT policy --
-- same WITH CHECK (true) either role inserts under, so the two roles are
-- never permitted anything different from each other on this table.
-- Net exposure change is approximately zero (issue #2010 risk brief,
-- accepted by Ben's authorization above): a signed-in visitor gains
-- exactly the INSERT capability they already have by signing out first;
-- `leads` holds no other tenant's data and stays admin-only on SELECT via
-- the untouched `leads_admin_select` policy.
--
-- Scope, stated narrowly per the authorization above: this table, this
-- policy, nothing else. No other RLS policy on public.leads or any other
-- table is read, altered, or dropped by this migration.

BEGIN;

ALTER POLICY "Allow anonymous inserts" ON public.leads
  TO anon, authenticated;

COMMIT;
