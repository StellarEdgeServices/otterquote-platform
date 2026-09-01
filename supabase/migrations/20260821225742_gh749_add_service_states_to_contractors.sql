-- Migration: gh749_add_service_states_to_contractors
-- Filed by: gh-1438 migration reconciliation batch (Code lane)
-- Date filed: 2026-09-01
-- Original issue: #749 (contractor pre-approval — structured service_states column)
-- Tier: 3A, autonomous (purely additive column + backfill UPDATE)
-- Rollback: supabase/migrations_rollbacks/20260821225742_gh749_add_service_states_to_contractors_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/20260821225742_gh749_add_service_states_to_contractors_pre-flight.md
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 reconciliation (issue #1438) — it does NOT re-apply anything;
-- merging this PR is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-21, recorded in
-- supabase_migrations.schema_migrations as version 20260821225742,
-- name "gh749_add_service_states_to_contractors".
--
-- PROVENANCE: originally drafted as
-- supabase/migrations_drafts/gh749_add_service_states_to_contractors.sql
-- (left in place, untouched, for full annotated history). The SQL body
-- below was verified byte-for-byte identical to that draft's BEGIN/COMMIT
-- block via a read-only query against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-01, gh-1438 reconciliation. It is the literal record of what
-- ran, not a retype of the draft.

BEGIN;

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS service_states text[] NULL;

UPDATE public.contractors c
SET service_states = sub.states
FROM (
  SELECT id, array_agg(DISTINCT upper(btrim(state))) AS states
  FROM (
    SELECT id, unnest(string_to_array(service_area_description, ',')) AS state
    FROM public.contractors
    WHERE service_area_description IS NOT NULL AND btrim(service_area_description) <> ''
    UNION ALL
    SELECT id, split_part(county_entry, ':', 1) AS state
    FROM public.contractors, unnest(service_counties) AS county_entry
    WHERE service_counties IS NOT NULL AND array_length(service_counties, 1) > 0
  ) derived
  WHERE btrim(state) <> ''
  GROUP BY id
) sub
WHERE c.id = sub.id;

COMMIT;
