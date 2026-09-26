-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- gh-2145 follow-up: UNLOGGED only changes WAL durability, not the
-- Data-API grant story -- it still needs an explicit service_role grant
-- like any other new table.

BEGIN;

CREATE UNLOGGED TABLE IF NOT EXISTS public.session_metrics_scratch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

COMMIT;
