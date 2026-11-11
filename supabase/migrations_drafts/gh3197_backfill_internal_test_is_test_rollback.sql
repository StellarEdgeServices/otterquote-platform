-- STATUS (as of 2026-11-11): NOT APPLIED -- DRAFT (re-headed to the live set; supersedes the 2026-11-01 40/3 version, R-097 notice 6806240445)
-- FILE ROLE: rollback file of set gh3197_backfill_internal_test_is_test
-- EVIDENCE: production read-only 2026-11-11 ~20:20Z (project yeszghaspzwwstvsrioa, SELECT only): 34 profiles with is_internal_test_email(email) and is_test IS NOT TRUE,
--   and 2 claims owned by them with is_test IS NOT TRUE. Control (profiles NOT is_internal_test_email and is_test IS NOT TRUE): 10 rows, left(md5(string_agg(id::text, ',' ORDER BY id)),12) = 64f8f4a1eebd.
--   (6 of the earlier 40 profiles and 1 of the earlier 3 claims were flagged by something else after 2026-11-01 and are NOT in this set.) No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- MUST RUN AS service_role / postgres: profiles_freeze_privileged_columns refuses is_test changes from client roles (gh-2785).
--
-- Rollback: sets is_test back to false on exactly the rows the re-headed backfill changes (34 profiles + 2 claims, ids read 2026-11-11 by the same WHERE clause
-- as the forward file; hard-coded). It never touches rows flagged by anything else, and rows created or flagged after 2026-11-11 are not touched.
-- Run only if the backfill must be undone: it re-inflates real counts. Do NOT use the pre-2026-11-11 version of this file (it listed 40 + 3 ids, 6 profiles + 1 claim already flagged by other means).
-- The row-count aborts roll the transaction back if any listed row is not currently is_test = true.

BEGIN;

DO $rb$
DECLARE n int;
BEGIN
  UPDATE public.claims SET is_test = false WHERE is_test IS TRUE AND id IN (
  '4595b6f0-8bf2-4161-b8b7-00a5bd0898cb',
  '5c16cc1e-c5c4-40b7-9e72-24eda0da999b'
  );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'gh-3197 rollback: expected 2 claims, got %', n; END IF;

  UPDATE public.profiles SET is_test = false WHERE is_test IS TRUE AND id IN (
  '0b9d23f5-965b-4b01-9295-6b22a9929afc',
  '11e38036-e8da-46a7-b062-507629b19279',
  '162f7e74-58ee-4df2-ba79-e66b8075bada',
  '16a39dc8-5040-4ef5-8fc4-d4e3c0758a30',
  '1bb6b297-51fc-4b22-afe0-2594ab173ba2',
  '1e886b0c-d179-46c9-bb59-2abc3ce79691',
  '20044899-aff8-4d55-b456-dbb9343f9a35',
  '22fa967e-7c22-4101-bef4-532d18f19a70',
  '2c1e9b0f-19ee-49d4-984c-68f4ff34ab89',
  '2dfcb565-2661-41af-a4d8-f01ffc45254d',
  '32ce03db-9a48-4916-96d5-5df608c9c365',
  '330425a9-d3de-49f6-8a76-bf79e31f5591',
  '36a7141b-70fa-4046-b022-3e182022db63',
  '3bc901a1-33f4-4495-8981-e784d47ec56c',
  '4de9f18e-fdb6-4d95-8a31-b3a362002b19',
  '525f3d15-1290-4f91-a9a7-bce35698dcd0',
  '5afddb5c-3ed3-4499-8311-b7122f104729',
  '6d10fd13-c137-4fe8-82f1-707557279aa9',
  '77d07836-ddc2-4bd3-8b0a-4de2a1353c4b',
  '7baa837c-c1fa-4e8d-9a04-c5a3a6d1e90c',
  '83935e2e-e421-4cc5-b9b5-b74a09099841',
  '8ec67b38-ca6d-410d-8d65-19cd3fb78508',
  '8fada7d1-3eec-4948-bd89-4e3118802a76',
  '92379db8-5294-4694-82ea-8a5ddbea419b',
  '97971ddc-f688-4729-9714-1a48f1fe221a',
  '9a9620bd-e6b9-4fae-98d4-72e346711313',
  'a3691ac9-fbb4-4fd0-b50f-26bdce5970c9',
  'ab623954-224a-42e5-95d9-69df08eecce5',
  'b3ea9fca-a336-46e8-b98f-a8f73084372d',
  'b98e2b27-07bb-4671-84b3-4b555479cc49',
  'ba9d3c57-f8e7-480d-ab9e-6daec134bd6c',
  'c213d1d5-2f5a-434b-afd5-09e2c87cb3c8',
  'd0c5eee4-477c-410e-8341-c2c038f47d4d',
  'dc35b92f-fb3e-49b2-927a-f883f1bb831a'
  );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 34 THEN RAISE EXCEPTION 'gh-3197 rollback: expected 34 profiles, got %', n; END IF;
END
$rb$;

COMMIT;
