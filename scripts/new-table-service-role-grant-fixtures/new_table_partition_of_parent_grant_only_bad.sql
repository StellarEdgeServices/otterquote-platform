-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- gh-2145 follow-up: Postgres privileges are per-relation -- a partition
-- is its own relation with its own ACL, distinct from its parent's. A
-- grant naming only the PARENT table (measurement_events) does NOT cover
-- the new partition (measurement_events_2027_01).

BEGIN;

CREATE TABLE IF NOT EXISTS public.measurement_events_2027_01
  PARTITION OF public.measurement_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.measurement_events TO service_role;

COMMIT;
