-- Migration: v6_contractor_profile_sync
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-08T00:55:55Z, recorded in
-- supabase_migrations.schema_migrations as version 20260508005555, name
-- "v6_contractor_profile_sync". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.


-- ADR-010 follow-up: DB-level prevention for profiles.role drift
-- When a contractor record is inserted, immediately sync profiles.role = 'contractor'.
-- This closes the creation-time gap that allowed the bug in 86e19gfky to form:
-- a contractor who signed up could have profiles.role = 'homeowner' if handleAuthCallback
-- processed cs_signup before the trigger could fire. With this trigger in place,
-- the contractors INSERT itself ensures the profile is correct.

CREATE OR REPLACE FUNCTION sync_contractor_profile_role()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles
  SET role = 'contractor',
      updated_at = NOW()
  WHERE id = NEW.user_id
    AND (role IS NULL OR role != 'contractor');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_contractor_profile_role ON contractors;

CREATE TRIGGER trg_sync_contractor_profile_role
  AFTER INSERT ON contractors
  FOR EACH ROW
  EXECUTE FUNCTION sync_contractor_profile_role();
