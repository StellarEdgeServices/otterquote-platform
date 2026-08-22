-- Migration: gh749_add_service_states_to_contractors
-- Author: Code lane sub-agent (automated), run-work orchestration
-- Date: 2026-08-21
-- Status: DRAFT — Tier 3A, autonomous (purely additive: one new nullable
--         column + a one-time backfill UPDATE that only touches the new
--         column; nothing existing is read differently, nothing dropped,
--         nothing destroyed). Per the #916 tier-test precedent
--         (issuecomment-5346544316): "purely additive (new nullable
--         columns, new tables, indexes) … is Tier 3A and autonomous."
-- Rollback: gh749_add_service_states_to_contractors_rollback.sql
-- Pre-flight: gh749_add_service_states_to_contractors_pre-flight.md
-- GitHub: #749 (contractor pre-approval — structured service_states column)
--
-- Summary: adds a nullable service_states text[] column to public.contractors
-- (structured state coverage, replacing free-text parsing of
-- service_area_description / service_counties for admin filtering) and
-- backfills it for every row that already carries derivable state data from
-- either legacy source. service_area_description and service_counties are
-- left untouched — this is additive, not a migration off either column.

BEGIN;

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS service_states text[] NULL;

-- One-time backfill: union state codes derived from both legacy sources.
--   - service_area_description: free-text, comma-joined state codes
--     (live data as of 2026-08-21 is a single code per row, e.g. "IN", but
--     the split handles multi-value rows too).
--   - service_counties: array of "STATE:county" / "STATE:*" strings (e.g.
--     "IN:*") — state code is the prefix before the colon, NOT a suffix
--     after a hyphen (admin-contractors.html's existing derivation comment
--     assumed the latter and does not actually match live data).
-- Rows with neither source populated are left NULL (2 of 11 live rows).
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
