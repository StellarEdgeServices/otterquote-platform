-- Migration: gh820_accept_public_directory_rpc_risk
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-14T01:37:24Z, recorded in
-- supabase_migrations.schema_migrations as version 20260814013724, name
-- "gh820_accept_public_directory_rpc_risk". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

COMMENT ON FUNCTION public.get_contractors_public() IS
'Public directory RPC (SECURITY DEFINER required — anon has no RLS grant on contractors). Column list excludes email/phone/full address/government ID; license_number is public-record. Reviewed #820, 2026-08-14 — accepted as intentional design.';

COMMENT ON FUNCTION public.get_referral_agents_public() IS
'Public directory RPC (SECURITY DEFINER required — anon has no RLS grant on referral_agents). unique_code/recruit_code are referral codes meant to be shared publicly (already embedded in URL params on refer-a-friend.html, ref-*.html, partner-*.html, recruit.html). Reviewed #820, 2026-08-14 — accepted as intentional design.';
