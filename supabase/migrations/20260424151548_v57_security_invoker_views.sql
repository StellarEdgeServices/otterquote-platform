-- Migration: v57_security_invoker_views
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-24T15:15:48Z, recorded in
-- supabase_migrations.schema_migrations as version 20260424151548, name
-- "v57_security_invoker_views". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v57: Convert 4 public reporting views from implicit SECURITY DEFINER (postgres owner)
-- to explicit SECURITY INVOKER. RLS on members table now applies to view queries.
-- admin_contractor_last_logins is intentionally excluded — requires auth.users access.

CREATE OR REPLACE VIEW public.contribution_summary
WITH (security_invoker = true) AS
  SELECT unnest(contributions) AS contribution_type,
    count(*) AS member_count
  FROM members
  WHERE status = 'active'
  GROUP BY (unnest(contributions))
  ORDER BY (count(*)) DESC;

CREATE OR REPLACE VIEW public.org_summary
WITH (security_invoker = true) AS
  SELECT COALESCE(organization, '(Not provided)'::text) AS organization,
    count(*) AS member_count,
    array_agg(DISTINCT state) AS states_represented
  FROM members
  WHERE status = 'active'
  GROUP BY organization
  ORDER BY (count(*)) DESC;

CREATE OR REPLACE VIEW public.referral_network
WITH (security_invoker = true) AS
  SELECT m.id,
    (m.first_name || ' '::text) || m.last_name AS member_name,
    m.email,
    m.organization,
    m.state,
    m.referred_by,
    m.contributions,
    m.registered_at,
    count(r.id) AS people_referred
  FROM members m
    LEFT JOIN members r ON
      r.referred_by ~~* (m.first_name || '%'::text)
      OR r.referred_by ~~* (('%'::text || m.last_name) || '%'::text)
      OR r.referred_by = m.email
  GROUP BY m.id, m.first_name, m.last_name, m.email,
    m.organization, m.state, m.referred_by, m.contributions, m.registered_at
  ORDER BY m.registered_at;

CREATE OR REPLACE VIEW public.state_summary
WITH (security_invoker = true) AS
  SELECT state,
    count(*) AS member_count
  FROM members
  WHERE status = 'active'
  GROUP BY state
  ORDER BY (count(*)) DESC;
