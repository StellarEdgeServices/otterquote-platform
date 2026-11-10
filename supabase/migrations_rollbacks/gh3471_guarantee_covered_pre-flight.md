# gh-3471 pre-flight: the covered-state column on hover_orders (Tier 3B: money path, additive)

Forward: `supabase/migrations_drafts/gh3471_guarantee_covered.sql` (apply alone, then deploy `create-measurement-order`).
Rollback: `supabase/migrations_rollbacks/gh3471_guarantee_covered_rollback.sql` (drops the constraint and the one column; deletes stored coverage values only; the clock is untouched).
Proof on throwaway Postgres: `bash supabase/tests/gh3471_guarantee_covered_proof_run.sh` (BEFORE / AFTER / re-run / ROLLBACK x2 / REAPPLIED, plus this document's checks).
The author made no production read; everything below marked UNVERIFIED is for the applier. R-097 notice waived by Dustin for #3471 only (6743525034); every other gate applies.

## What the change does
Adds `hover_orders.guarantee_covered` (`boolean`, nullable, no default) and the CHECK `hover_orders_guarantee_covered_chk` (`guarantee_covered IS NULL OR guarantee_started_at IS NOT NULL`). `create-measurement-order`, for an order that gets the 100-hour clock (non-test, non-contractor, readable payment time), reads `platform_settings` key `guarantee_excluded_states` and writes `guarantee_covered` in the same INSERT: `true` when the claim's `property_state` (trim, upper, must be two letters A-Z) is not on the list, `false` when it is. Unknown is left NULL and not written: list row absent (logged only), list malformed / unreadable, claim unreadable, or no usable state (each raises a `platform_alerts_log` row, alert_type `guarantee_coverage_unknown`). Payment, order status, amounts, emails, pages and checkout are unchanged. **This schema file inserts no `platform_settings` row.** The list (Dustin, 2026-11-09) is a separate data file, `gh3471_guarantee_excluded_states_seed.sql`; until it is applied every order records NULL.

## Read-only checks before the apply (SELECTs only; UNVERIFIED by the author)
```sql
-- 1. the column does not exist yet (expect 0 rows); the clock columns do (expect 2)
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name = 'guarantee_covered';
SELECT count(*) AS clock_columns FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name IN ('guarantee_started_at','guarantee_deadline_at');
-- 2. the constraint name is free (expect 0); the clock CHECK exists and is validated (expect 1)
SELECT count(*) AS covered_chk FROM pg_constraint WHERE conname = 'hover_orders_guarantee_covered_chk';
SELECT count(*) AS clock_chk_validated FROM pg_constraint WHERE conname = 'hover_orders_guarantee_clock_chk' AND convalidated;
-- 3. policies unchanged since the clock apply: expect hover_orders_admin_all (ALL) and hover_user_read (SELECT) only; RLS on
SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename='hover_orders' ORDER BY policyname;
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hover_orders'::regclass;
-- 4. the list is NOT set yet (expect 0 rows), and the key is not on the authenticated allow-list policy (expect false)
SELECT key, value FROM public.platform_settings WHERE key = 'guarantee_excluded_states';
SELECT coalesce(bool_or(qual LIKE '%guarantee_excluded_states%'), false) AS key_client_readable FROM pg_policies WHERE schemaname='public' AND tablename='platform_settings';
-- 5. size, and how many orders already carry a clock (they keep NULL coverage; see "Backfill" below)
SELECT count(*) AS rows, count(guarantee_started_at) AS rows_with_clock FROM public.hover_orders;
```

## How to apply
1. `psql -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh3471_guarantee_covered.sql` (alone; it carries its own BEGIN ... COMMIT). Read back:
   - `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name='guarantee_covered';` -> boolean, YES, null
   - `SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='hover_orders_guarantee_covered_chk';` -> true
2. Deploy `create-measurement-order` (verify the deployed bytes contain `guarantee_excluded_states` and `guarantee_covered`).
3. While the list is unset: a real order gets its clock and `guarantee_covered` NULL, and the function logs `excluded-state list not configured yet`; no alert.
4. Dustin named the list on 2026-11-09, verbatim: "#3471: excluded states are FL, LA, TX, OK, AR, KS, NE, MI, KY (Dustin 11-09), stored as config." (#3471 comment 6744041238). Apply the SEPARATE seed after step 1: `psql -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh3471_guarantee_excluded_states_seed.sql` (idempotent, ON CONFLICT DO NOTHING, refuses if platform_settings is missing, warns and keeps a different existing value; rollback `supabase/migrations_rollbacks/gh3471_guarantee_excluded_states_seed_rollback.sql` deletes exactly the two seeded rows while they still hold the seeded values). MI is recorded as given; #3321 uses MS; Marty is confirming MI with Dustin. A later change is one statement, no deploy (codes are two letters; `[]` = nothing excluded):
   `INSERT INTO public.platform_settings (key, value) VALUES ('guarantee_excluded_states', '["XX","YY"]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`
   Read back: `SELECT value FROM public.platform_settings WHERE key='guarantee_excluded_states';`. A malformed value (any element not two letters) makes the whole list unusable: every order records NULL and alerts, so a typo never covers a state.
5. Staging negative control (Stripe test mode): a test-mode purchase leaves `guarantee_started_at` and `guarantee_covered` NULL and the list is not read.

## Backfill (not done here; a decision for Marty/Ben)
Orders paid between the clock apply (20261108222038) and the list being set keep `guarantee_covered` NULL. Once the list exists they can be filled from `claims.property_state` with one reviewed UPDATE (only rows with a clock, only valid two-letter states), or left NULL and decided by hand. This migration does neither.

## Rollback and monitoring
Rollback is safe to run twice and touches only the one column and its constraint. Watch for 30 minutes after the deploy: `create-measurement-order` logs (no `order insert failed AFTER successful payment`, no `guarantee_covered column missing`), and `SELECT alert_type, count(*) FROM platform_alerts_log WHERE alert_type IN ('guarantee_coverage_unknown','guarantee_clock_not_stored') AND sent_at > now() - interval '1 hour' GROUP BY 1` (expect 0 while the list is unset). Roll back if any paid order fails to record.

## Danger-pattern check
Additive only: one nullable column with no default (metadata-only ALTER, no rewrite) and one CHECK added NOT VALID then validated over all-NULL coverage in the same transaction. Re-runnable (drops the constraint first). No NOT NULL on an existing table, no DROP/RENAME/TRUNCATE/CASCADE, no index, no function, no new table (so no RLS / service_role GRANT / TRUNCATE-revoke obligations), no policy or grant change, no trigger, no data row.
