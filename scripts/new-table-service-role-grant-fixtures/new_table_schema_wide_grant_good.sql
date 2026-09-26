-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- Positive control: a schema-wide `ALL TABLES IN SCHEMA public` grant to
-- service_role covers a new table too, even without naming it directly.

BEGIN;

CREATE TABLE IF NOT EXISTS public.warranty_manifest_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

COMMIT;
