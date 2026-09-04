-- Migration: v80_check_rate_limit_uuid_text_overload
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-14T13:46:53Z, recorded in
-- supabase_migrations.schema_migrations as version 20260514134653, name
-- "v80_check_rate_limit_uuid_text_overload". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v80 — Codify check_rate_limit(p_caller_id uuid, p_function_name text) overload
-- Surfaced by pfw-1778709516 (May 13, 2026). Live in production DB but never persisted.
-- This pins the alias overload into versioned migrations. Sentinel: v80-check-rate-limit-uuid-text-overload.

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_caller_id uuid,
  p_function_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Alias for the canonical (p_function_name text, p_user_id uuid) signature.
  -- EFs that pass (uuid, text) positional args resolve to this overload and
  -- delegate to the canonical implementation via named parameters.
  RETURN public.check_rate_limit(
    p_function_name => p_function_name,
    p_user_id       => p_caller_id
  );
END;
$function$;
