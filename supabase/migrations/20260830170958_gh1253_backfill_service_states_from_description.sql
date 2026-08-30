-- gh-1253 backfill: pre-PR-#1358 wizard rows wrote the contractor's selected states
-- only to the free-text `service_area_description` column. Both `service_states` and
-- `service_counties` null means process-auto-bids' `inServiceArea` fallback returns
-- TRUE (supabase/functions/process-auto-bids/index.ts:156-163) -- such a contractor
-- matches EVERY state, silently. PR #1358 stopped new rows landing in that shape;
-- it does not retroactively populate the rows already there.
--
-- Prescribed verbatim by the CTO ruling `cto-2026-08-30T14:10:10Z` on issue #1253.
-- Tier 3A: additive data repair on a nullable column, fully reversible, zero real rows.
--
-- !! NOT YET APPLIED -- this file is a PENDING change, not a historical record. !!
-- This deliberately differs from the gh-945 / gh-1028 / gh-1302 precedent in this
-- directory, where the migration was applied via apply_migration first and the file
-- committed afterwards as a trace. The session that authored this file (run-work
-- rw-f22-20260830T170846-a9da, remote Linux container) had its direct production
-- write blocked by the environment's write classifier, so the change is routed
-- through the normal D-221 Path A deploy chain instead: merging this PR APPLIES it.
-- Read the pre-flight note beside this file before merging.
--
-- Enumerated live against production yeszghaspzwwstvsrioa on 2026-08-30T17:09Z,
-- before this file was written. 13 contractor rows total, all is_test = true, all
-- auto_bid_enabled = false (so the live blast radius is nil at time of writing).
-- Exactly ONE row matches this predicate:
--   986ce2b6-39fd-4a2c-aba4-a806c618c8c0  "PFW Roofing 1787836001"
--     service_states = NULL, service_counties = NULL, service_area_description = 'IN'
--     -> becomes service_states = {IN}
--
-- The regex guard is deliberate (CTO's wording): it fires only where the free-text
-- column is already a clean list of two-letter codes, and leaves anything
-- prose-shaped alone rather than guessing at a service area.
--
-- Idempotent: the predicate self-excludes once the row is populated, so a re-run
-- is a no-op. Re-runnable safely if the migration runner replays it.
--
-- NOT closed by this migration -- surfaced on the issue thread, not decided here:
-- two further rows fall through to the same "matches every state" branch and this
-- predicate cannot repair them, because neither carries a recoverable service area:
--   ee452a12-c16e-4d30-9d2c-df8128fbce52  "Stohler Roofing, LLC"
--     service_states NULL, service_counties = '{}' (empty array, not null), description NULL
--   f3350ae0-2fa1-4ae6-9751-79a0790f07f3  "" (blank company name, abandoned stub)
--     all three columns NULL
-- Note ee452a12 is not even caught by the CTO's `service_counties IS NULL` clause --
-- an EMPTY ARRAY is not NULL in SQL, but it IS falsy to the EF's `.length > 0` check,
-- so it reaches the include-everything branch all the same. Widening the predicate
-- would not help it: there is no description to derive states from. The durable fix
-- for that shape is the EF fallback itself, which is a matching-semantics change on
-- a money-path function and is left to the CTO -- see the issue thread.
--
-- Refs #1253

UPDATE contractors
   SET service_states = string_to_array(replace(service_area_description, ' ', ''), ','),
       updated_at     = now()
 WHERE service_states IS NULL
   AND service_counties IS NULL
   AND service_area_description ~ '^[A-Z]{2}(,\s*[A-Z]{2})*$';
