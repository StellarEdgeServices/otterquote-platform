-- gh-3471: the 100-hour clock, stored on the hover_orders row create-measurement-order writes after it verifies the PaymentIntent. Two nullable columns and one CHECK. Nothing else.
-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (ledger version 20261108222038, name gh3471_guarantee_clock; read-only ledger query, CTO RUN 104, #3324; the lines below are the pre-apply drafting record)
-- EVIDENCE: drafted on main 9e67d3eda by reading the repo (supabase/migrations/20260101000000_v000_baseline_schema.sql hover_orders, create-measurement-order/index.ts, the gh3428 draft). No production read was made by the author (no database connection, by instruction): the applier runs the pre-flight checks.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, review, R-097 notice, a recorded apply). tier:3b was set by Marty on #3471.
-- Rollback: supabase/migrations_rollbacks/gh3471_guarantee_clock_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3471_guarantee_clock_pre-flight.md
-- ORDER: apply THIS file first, THEN deploy create-measurement-order (it also tolerates the columns being absent: it retries the order insert without them when PostgREST answers PGRST204 or Postgres answers 42703, and alerts).
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE (psql -v ON_ERROR_STOP=1 -f). Never wrap it.
--
-- Design: the clock lives on the order row because that row is the one durable "payment reached succeeded" fact (there is no payments table for hover_measurement; #3428 comment 6667297771),
-- and it is written in the SAME INSERT as the order, so no second write can fail after the money moved. stripe-webhook is not touched.
--   guarantee_started_at   the time the payment succeeded (the Stripe charge's created time, read by create-measurement-order)
--   guarantee_deadline_at  guarantee_started_at + exactly 100 hours
-- Both are NULL for every existing order, for every is_test order, for contractor-role orders, and for any payment whose success time could not be read. The columns store a clock; they decide
-- nothing about what it promises (the words, beat-an-offer terms and the refund mechanics are Dustin's, #3427 / #3472).
-- The CHECK keeps the pair honest: both null, or both set with the deadline exactly 100 hours after the start (timestamptz + interval '100 hours' is elapsed time; no daylight-saving drift).
-- Client access: hover_orders has one non-admin policy, SELECT on the buyer's own rows (hover_user_read); there is no INSERT/UPDATE policy for authenticated, so a homeowner cannot write a clock. Admin has hover_orders_admin_all.

BEGIN;

ALTER TABLE public.hover_orders
  ADD COLUMN IF NOT EXISTS guarantee_started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS guarantee_deadline_at timestamptz;

COMMENT ON COLUMN public.hover_orders.guarantee_started_at IS
  'gh-3471: when the measurement payment succeeded (Stripe charge created time), set by create-measurement-order in the same INSERT as the order. NULL for test orders, contractor-role orders, orders from before gh-3471, and payments whose success time could not be read.';
COMMENT ON COLUMN public.hover_orders.guarantee_deadline_at IS
  'gh-3471: guarantee_started_at + exactly 100 hours (CHECK hover_orders_guarantee_clock_chk). A clock only; what it promises is decided elsewhere (#3427).';

-- The pair is all-or-nothing: both NULL, or BOTH set with the deadline exactly 100 hours after the start. A start with no deadline, or a deadline with no start, is refused
-- (a bare `deadline = start + 100h` would pass on NULL, because NULL = x is NULL and a CHECK accepts NULL). Dropped first so a re-run of this file is safe.
-- NOT VALID then VALIDATE: new rows are enforced at once, then existing rows (all NULL) are checked. Both run inside this transaction, so the table lock is held until COMMIT (trivial here: the table is small).
ALTER TABLE public.hover_orders DROP CONSTRAINT IF EXISTS hover_orders_guarantee_clock_chk;
ALTER TABLE public.hover_orders
  ADD CONSTRAINT hover_orders_guarantee_clock_chk CHECK (
    (guarantee_started_at IS NULL AND guarantee_deadline_at IS NULL)
    OR (guarantee_started_at IS NOT NULL AND guarantee_deadline_at IS NOT NULL AND guarantee_deadline_at = guarantee_started_at + interval '100 hours')
  ) NOT VALID;
ALTER TABLE public.hover_orders VALIDATE CONSTRAINT hover_orders_guarantee_clock_chk;

COMMIT;
