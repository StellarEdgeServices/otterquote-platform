-- gh-3471 (#3427 D6): the covered-state result, recorded on the hover_orders row beside the 100-hour clock. One nullable boolean and one CHECK. Nothing else.
-- STATUS (gh-1438, as of 2026-11-09): NOT APPLIED
-- EVIDENCE: drafted on main 00e9d0d0 by reading the repo (supabase/migrations_drafts/gh3471_guarantee_clock.sql, applied as ledger 20261108222038 per #3471 comment 6727950306;
--   create-measurement-order/index.ts; the gh-2421 platform_settings state-list precedent). No production read was made by the author: the applier runs the pre-flight checks.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, independent proof, a recorded apply). Dustin waived the R-097 notice for #3471 only (6743525034).
-- Rollback: supabase/migrations_rollbacks/gh3471_guarantee_covered_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3471_guarantee_covered_pre-flight.md
-- Proof (throwaway Postgres): supabase/tests/gh3471_guarantee_covered_proof_run.sh
-- ORDER: apply THIS file first, THEN deploy create-measurement-order. The function also tolerates the column being absent: it writes guarantee_covered only when coverage
--   is known, and on PGRST204/42703 it retries without guarantee_covered (keeping the clock) and alerts.
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE (psql -v ON_ERROR_STOP=1 -f). Never wrap it.
--
-- THE LIST IS NOT HERE. The excluded-state list is configuration: platform_settings key 'guarantee_excluded_states', a JSON array of two-letter codes (precedent: gh-2421
-- 'homeowner_blocked_states'). This file inserts NO row: no state is excluded or covered by this migration. While the row is absent every order records NULL (unknown).
-- When Dustin names the list (Ben's legal review), the operator runs ONE statement, no deploy:
--   INSERT INTO public.platform_settings (key, value) VALUES ('guarantee_excluded_states', '["XX","YY"]'::jsonb)
--     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--   ('[]' means "nothing excluded": every valid state is covered.) platform_settings has RLS on and its only authenticated policy is a key allow-list SELECT that does not
--   include this key, so the list is readable and writable by the service role / SQL only. No policy, grant or table is created or changed here.
--
-- guarantee_covered: true = the claim's state is not on the list; false = it is; NULL = unknown (list unset or malformed or unreadable, claim unreadable, no usable state),
-- and NULL for every order without a clock (is_test, contractor-role, unreadable payment time, orders before gh-3471). It records coverage; it blocks nothing.
-- The CHECK keeps it beside a clock: a coverage value on an order with no clock is refused.
-- Client access: unchanged. hover_user_read lets the buyer SELECT their own row (so this column too, like the clock columns); no client INSERT/UPDATE policy exists.

BEGIN;

ALTER TABLE public.hover_orders
  ADD COLUMN IF NOT EXISTS guarantee_covered boolean;

COMMENT ON COLUMN public.hover_orders.guarantee_covered IS
  'gh-3471 (#3427 D6): whether the claim''s property_state was outside the excluded-state list (platform_settings guarantee_excluded_states) when the order was recorded. true = covered, false = excluded state, NULL = unknown or no clock. Set by create-measurement-order in the same INSERT as the order; records only, never blocks a payment.';

-- Coverage only beside a clock. Dropped first so a re-run is safe. NOT VALID then VALIDATE (existing rows are all NULL); both inside this transaction.
ALTER TABLE public.hover_orders DROP CONSTRAINT IF EXISTS hover_orders_guarantee_covered_chk;
ALTER TABLE public.hover_orders
  ADD CONSTRAINT hover_orders_guarantee_covered_chk CHECK (guarantee_covered IS NULL OR guarantee_started_at IS NOT NULL) NOT VALID;
ALTER TABLE public.hover_orders VALIDATE CONSTRAINT hover_orders_guarantee_covered_chk;

COMMIT;
