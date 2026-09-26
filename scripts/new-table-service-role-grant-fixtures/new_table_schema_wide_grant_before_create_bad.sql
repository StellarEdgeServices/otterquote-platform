-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- gh-2145 follow-up (Ben's REVIEW PASS 5839898750, ordering): a schema-wide
-- `ALL TABLES IN SCHEMA public` grant only reaches tables that ALREADY
-- EXIST when it runs. Placed BEFORE this CREATE TABLE, it does not cover
-- the new table -- and does not error either, so this is a silent gap.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

CREATE TABLE IF NOT EXISTS public.warranty_manifest_v3 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

COMMIT;
