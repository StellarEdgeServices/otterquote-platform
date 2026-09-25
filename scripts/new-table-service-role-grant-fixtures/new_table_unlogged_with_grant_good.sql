-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- gh-2145 follow-up: an UNLOGGED table with its own explicit, correctly
-- ordered service_role grant is treated exactly like a normal table.

BEGIN;

CREATE UNLOGGED TABLE IF NOT EXISTS public.session_metrics_scratch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_metrics_scratch TO service_role;

COMMIT;
