-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- gh-2145 follow-up: a partition covered by its OWN explicit,
-- correctly-ordered service_role grant (naming the partition itself, not
-- just the parent) passes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.measurement_events_2027_01
  PARTITION OF public.measurement_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.measurement_events_2027_01 TO service_role;

COMMIT;
