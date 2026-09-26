-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- gh-2145 follow-up: TEMP/TEMPORARY tables are session-local (pg_temp),
-- invisible to the Data API and gone at session/transaction end -- exempt
-- entirely, no grant expected or required, even though this migration
-- grants nothing to service_role at all.

BEGIN;

CREATE TEMP TABLE bulk_import_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_row JSONB NOT NULL
);

CREATE TEMPORARY TABLE another_scratch_pad (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

COMMIT;
