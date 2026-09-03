-- gh-1253 backfill, re-stamped and applied directly (this file is a POST-APPLY TRACE,
-- per the gh-945 / gh-1028 / gh-1302 precedent in this directory).
--
-- The original migration (20260830170958_gh1253_backfill_service_states_from_description.sql,
-- merged via PR #1366, 2026-08-31T03:21Z) was silently skipped by the Supabase migration
-- runner's high-water-mark mechanism: its version timestamp (17:09Z, when the file was
-- authored) was older than v116_accept_bid_rpc's (20260830192051, applied ~19:20Z), so a
-- migration that arrived later carrying an earlier timestamp was never run. Confirmed live
-- 2026-08-31T11:37Z before this ran: schema_migrations high-water mark = 20260830192051,
-- 20260830170958 absent, target row (986ce2b6, "PFW Roofing 1787836001") unchanged --
-- service_states=NULL, service_counties=NULL, service_area_description='IN', is_test=true,
-- auto_bid_enabled=false. See run-work thread rw-f22-20260831T113654-y93t / issue #1253 for
-- the full diagnosis (posted by rw-f22-20260830T170846-a9da at 2026-08-31T03:23:56Z).
--
-- SQL is byte-identical to the original file's forward half. Applied via `apply_migration`
-- as 20260831113959 and verified: service_states now {IN} on the target row.
--
-- Prescribed verbatim by CTO ruling cto-2026-08-30T14:10:10Z on issue #1253. Tier 3A:
-- additive data repair on a nullable column, fully reversible, zero real rows
-- (all 13 contractor rows are is_test=true). Idempotent -- predicate self-excludes once
-- a row is populated, so a re-run is a no-op.
--
-- Refs #1253

UPDATE contractors
   SET service_states = string_to_array(replace(service_area_description, ' ', ''), ','),
       updated_at     = now()
 WHERE service_states IS NULL
   AND service_counties IS NULL
   AND service_area_description ~ '^[A-Z]{2}(,\s*[A-Z]{2})*$';
