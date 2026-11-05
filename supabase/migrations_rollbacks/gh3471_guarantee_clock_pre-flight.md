# gh-3471 pre-flight: the 100-hour clock columns on hover_orders (Tier 3B: money path, additive)

Forward: `supabase/migrations_drafts/gh3471_guarantee_clock.sql` (apply alone, then deploy `create-measurement-order`).
Rollback: `supabase/migrations_rollbacks/gh3471_guarantee_clock_rollback.sql` (drops the constraint and both columns; deletes the stored clock values only).
The author made no production read and no Supabase branch run; everything marked UNVERIFIED below is for the applier.

## What the change does
Adds `hover_orders.guarantee_started_at` and `hover_orders.guarantee_deadline_at` (both `timestamptz`, nullable, no default) and the CHECK `hover_orders_guarantee_clock_chk` (both NULL, or both set with deadline = start + `interval '100 hours'`). `create-measurement-order` writes both in the same INSERT as the order when a NON-TEST measurement payment has succeeded: start = the Stripe charge's created time (the PaymentIntent is fetched with `latest_charge` expanded), deadline = start + 100 hours. Test orders, contractor-role orders, the contractor upgrade, quote-only requests, orders from before this change, and payments whose success time cannot be read store NULL (the last also raises a `platform_alerts_log` row, alert_type `guarantee_clock_not_stored`). `stripe-webhook` is not edited. No customer-visible text, page, checkout or email changes.

## Read-only checks before the apply (SELECTs only; UNVERIFIED by the author)
```sql
-- 1. the columns do not exist yet (expect 0 rows) and the table is the one the function writes
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name IN ('guarantee_started_at','guarantee_deadline_at');
SELECT count(*) AS hover_orders_rows FROM public.hover_orders;                       -- size only; the ALTER is metadata-only (no default, nullable) so the count does not matter for locking
-- 2. the constraint name is free (expect 0)
SELECT count(*) FROM pg_constraint WHERE conname = 'hover_orders_guarantee_clock_chk';
-- 3. who can write hover_orders (the clock must not be client-writable): expect hover_user_read = SELECT only; no INSERT/UPDATE policy for authenticated
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname='public' AND tablename='hover_orders' ORDER BY policyname;
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hover_orders'::regclass;     -- expect true
-- 4. no trigger on hover_orders that could reject or rewrite the new columns (expect only trg_hover_orders_updated and the partner-fee accrual trigger)
SELECT tgname FROM pg_trigger WHERE tgrelid='public.hover_orders'::regclass AND NOT tgisinternal ORDER BY 1;
-- 5. the platform_alerts_log columns the alert row writes (expect 5 rows: alert_type, function_name, message, sent_at, id)
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_alerts_log' AND column_name IN ('alert_type','function_name','message','sent_at');   -- expect 4
-- 6. the is_internal_test_email rpc the function tries (optional; a failure is treated as "real"). Expect the function to exist; whether service_role may EXECUTE it is what this shows:
SELECT has_function_privilege('service_role', 'public.is_internal_test_email(text)', 'EXECUTE');
```

## How to apply
1. `psql -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh3471_guarantee_clock.sql` (alone; it carries its own BEGIN ... COMMIT). Read back:
```sql
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name LIKE 'guarantee_%' ORDER BY 1;   -- 2 rows, timestamptz, YES, null
SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='hover_orders_guarantee_clock_chk';                                                                         -- convalidated = true
SELECT count(*) FROM public.hover_orders WHERE guarantee_started_at IS NOT NULL;                                                                                                                      -- 0 until the function is deployed
```
2. Deploy `create-measurement-order` (verify the deployed bytes contain `expand%5B%5D=latest_charge`).
3. Negative control (staging, Stripe test mode): a test-mode purchase must leave both columns NULL (`livemode = false` and the is_test claim both suppress). A production-like purchase on an unflagged staff claim must set `guarantee_deadline_at - guarantee_started_at = 100:00:00` and `guarantee_started_at` equal to `to_timestamp(<charge.created>)` from the Stripe dashboard.
```sql
SELECT id, created_at, guarantee_started_at, guarantee_deadline_at, guarantee_deadline_at - guarantee_started_at AS span FROM public.hover_orders ORDER BY created_at DESC LIMIT 5;
```

## Not verified by the author, for Marty
1. Checks 1-6 against production.
2. That a Stripe charge's `created` is the right "payment succeeded" instant for every payment method this checkout accepts (cards: yes, the charge is created and settles in one step; delayed methods such as bank debits would settle later, and the checkout takes cards only as far as the repo shows). Question posted on #3471.
3. Staff test orders from a staff address the code does not list (the code lists the four `is_internal_test_email` domains, `otterquote.com`, and the `dustinstohler1` Gmail base; the second staff base is only reached through the optional `is_internal_test_email` rpc, check 6) and whose profile and claim are unflagged will get a clock. That is harmless (a clock records nothing owed) but it is a test order with a clock.

## Rollback and monitoring
Rollback is safe to run twice and touches only the two columns and the constraint. Watch after the deploy for 30 minutes: Sentry/logs for `create-measurement-order` (no `order insert failed AFTER successful payment`, no `columns missing` line), `SELECT alert_type, count(*) FROM platform_alerts_log WHERE alert_type='guarantee_clock_not_stored' GROUP BY 1` (expect 0 after the migration is applied), and the read-back above for the first real order. Roll back if any paid order fails to record.

## Danger-pattern check
Additive only: two nullable columns with no default (metadata-only ALTER, no table rewrite) and one CHECK added NOT VALID then validated over all-NULL rows (SHARE UPDATE EXCLUSIVE during validation, no long write block). No NOT NULL on an existing table, no DROP/RENAME/TRUNCATE/CASCADE, no index, no function, no new table, no RLS or grant change, no trigger. Pattern 9 (new public functions): none.
