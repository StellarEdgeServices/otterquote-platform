-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: rollback file of set gh3197_backfill_internal_test_is_test
-- EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): 38 profiles with is_internal_test_email(email) and is_test<>true
--   (gmail dustinstohler1 base 18, stellaredgeservices 13, otterquote 4, stohlerroof 2, tryotterquote 1) and 3 claims owned by them
--   (gmail 1, otterquote 1, tryotterquote 1). No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- MUST RUN AS service_role / postgres: profiles_freeze_privileged_columns refuses is_test changes from client roles (gh-2785).
--
-- Rollback: sets is_test back to false on exactly the rows the backfill changed (ids read 2026-10-30, hard-coded).
-- Rows that were created or flagged after 2026-10-30 are not touched. Run only if the backfill must be undone: it re-inflates real counts.

BEGIN;

UPDATE public.claims SET is_test = false WHERE id IN (
  '4595b6f0-8bf2-4161-b8b7-00a5bd0898cb',
  '5c16cc1e-c5c4-40b7-9e72-24eda0da999b',
  '16e18349-22e5-4834-935f-2567dbd3b88b'
);
-- expected: 3 rows

UPDATE public.profiles SET is_test = false WHERE id IN (
  '1bb6b297-51fc-4b22-afe0-2594ab173ba2',
  '0b9d23f5-965b-4b01-9295-6b22a9929afc',
  'dc35b92f-fb3e-49b2-927a-f883f1bb831a',
  'd71831ae-2c6d-487b-af52-ef0598d30448',
  '5556e95a-a3c9-44bf-b5ea-cf9b5132dea7',
  '3bc901a1-33f4-4495-8981-e784d47ec56c',
  '32ce03db-9a48-4916-96d5-5df608c9c365',
  '330425a9-d3de-49f6-8a76-bf79e31f5591',
  '8fada7d1-3eec-4948-bd89-4e3118802a76',
  '4de9f18e-fdb6-4d95-8a31-b3a362002b19',
  'ba9d3c57-f8e7-480d-ab9e-6daec134bd6c',
  '6d10fd13-c137-4fe8-82f1-707557279aa9',
  '7baa837c-c1fa-4e8d-9a04-c5a3a6d1e90c',
  '9a9620bd-e6b9-4fae-98d4-72e346711313',
  '5afddb5c-3ed3-4499-8311-b7122f104729',
  '22fa967e-7c22-4101-bef4-532d18f19a70',
  'bd8c0b28-eaff-457a-9b60-bd18a321c09e',
  '297661b9-3425-4781-aecf-2c4910942aa7',
  '2c1e9b0f-19ee-49d4-984c-68f4ff34ab89',
  '2dfcb565-2661-41af-a4d8-f01ffc45254d',
  '20044899-aff8-4d55-b456-dbb9343f9a35',
  'c213d1d5-2f5a-434b-afd5-09e2c87cb3c8',
  'd0c5eee4-477c-410e-8341-c2c038f47d4d',
  '92379db8-5294-4694-82ea-8a5ddbea419b',
  '525f3d15-1290-4f91-a9a7-bce35698dcd0',
  '8ec67b38-ca6d-410d-8d65-19cd3fb78508',
  '36a7141b-70fa-4046-b022-3e182022db63',
  'a3691ac9-fbb4-4fd0-b50f-26bdce5970c9',
  'b98e2b27-07bb-4671-84b3-4b555479cc49',
  '83935e2e-e421-4cc5-b9b5-b74a09099841',
  'ab623954-224a-42e5-95d9-69df08eecce5',
  '162f7e74-58ee-4df2-ba79-e66b8075bada',
  '11e38036-e8da-46a7-b062-507629b19279',
  '97971ddc-f688-4729-9714-1a48f1fe221a',
  '1e886b0c-d179-46c9-bb59-2abc3ce79691',
  '77d07836-ddc2-4bd3-8b0a-4de2a1353c4b',
  'b3ea9fca-a336-46e8-b98f-a8f73084372d',
  '16a39dc8-5040-4ef5-8fc4-d4e3c0758a30'
);
-- expected: 38 rows

COMMIT;
