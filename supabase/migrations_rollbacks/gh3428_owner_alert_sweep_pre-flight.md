# gh-3428 pre-flight: owner alert sweep (Tier 3B: an Edge Function that places a call; new table, three functions, one pg_cron job)

Forward, in this order: `supabase/migrations_drafts/gh3428_owner_alert_sweep.sql` (schema), deploy `owner-alert-sweep`, set the secrets, then `supabase/migrations_drafts/gh3428_owner_alert_sweep_cron.sql` (schedule).
Rollback: `supabase/migrations_rollbacks/gh3428_owner_alert_sweep_rollback.sql` (section 1 stops the schedule alone; section 2 drops the functions and the table).
Proof: `supabase/tests/gh3428_owner_alert_sweep_proof.sql` (runner `..._proof_run.sh`, schema `gh3428_throwaway_schema.sql`; throwaway Postgres only). The author made no production read and no Supabase branch run; everything marked UNVERIFIED below is for the applier (Marty).

## What the change does
Adds `public.owner_alerts` (unique `(event_kind, source_id)`, RLS on with no policy, `service_role` only), `owner_alert_claim_batch()` (enqueue qualifying events, lease due ones), `owner_alert_mark()` (record the call outcome), `owner_alert_is_internal(uuid)` (the shared "is this staff/test" predicate), all `SECURITY DEFINER`, `EXECUTE` for `service_role` only. Seeds `status = 'baseline'` rows for everything that already qualifies, so installing rings for nothing that already happened. The Edge Function `owner-alert-sweep` (service-role key only) calls the first function every 30 seconds via pg_cron, places one Twilio voice call per leased row, and records the result. `stripe-webhook`, `create-measurement-order`, `create-payment-intent` and every payment table are not edited; the new functions only SELECT from `hover_orders`, `claims`, `profiles` and only write `owner_alerts`.

## Exact event definitions (repo reading, main 32193ce7)
| event_kind | source table / id | qualifies when |
|---|---|---|
| `measurement_paid` | `hover_orders.id` | `homeowner_stripe_payment_intent_id IS NOT NULL` AND `requested_by_contractor_id IS NULL` AND `COALESCE(requested_by_role,'homeowner') = 'homeowner'` AND `product_code IS DISTINCT FROM 'roof_upgrade_detailed'` AND `created_at >= now() - 24h` AND the claim and both people pass the test checks below. The row exists only after create-measurement-order verified the PaymentIntent as succeeded (status `awaiting_fulfillment` on insert), so row-exists = payment succeeded. |
| `claim_bidding` | `claims.id` | `ready_for_bids IS TRUE` AND `status IN ('active','bidding')` AND `updated_at >= now() - 24h` AND the claim owner passes the test checks. `dashboard.html submitForBids()` writes `status='active', ready_for_bids=true`; first sight only (unique key), so `active -> bidding` on the same claim never rings twice. |

Test checks (all must pass, both events): `claims.is_test IS NOT TRUE`; owner (`claims.user_id`) and buyer (`hover_orders.user_id`) `profiles.is_test` not true; `public.is_internal_test_email(profiles.email)` false; e-mail domain not in (`otterquote.com`, `stellaredgeservices.com`, `tryotterquote.com`, `stohlerroof.com`, `otterquote-internal.test`). `hover_orders` has no `is_test`. `contractors.is_test` is deliberately not consulted (two meanings, gh-2055; contractor-bought orders are excluded by `requested_by_contractor_id IS NULL`).

False-alarm consequences: a staff test with an e-mail outside the domains above whose rows are unflagged (gh-3197: 40 profiles / 3 claims on 2026-11-01) rings once for that event. A real customer is never suppressed by these rules. Misses: a homeowner who pays but whose browser never reaches create-measurement-order has no `hover_orders` row and gets no measurement ring (the webhook is untouched by design); a claim whose `ready_for_bids` flips while the sweep is down for more than 24 hours is not enqueued.

## Read-only checks before the apply (SELECTs only; UNVERIFIED by the author)
```sql
-- 1. columns the function names exist with these types
SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND
  ((table_name='hover_orders' AND column_name IN ('id','claim_id','user_id','product_code','requested_by_role','requested_by_contractor_id','homeowner_stripe_payment_intent_id','created_at','status'))
  OR (table_name='claims' AND column_name IN ('id','user_id','status','ready_for_bids','property_state','is_test','updated_at'))
  OR (table_name='profiles' AND column_name IN ('id','email','is_test'))) ORDER BY 1,2;     -- expect 9 + 7 + 3 rows
-- 2. is_internal_test_email exists and its body (the function the predicate calls)
SELECT proname, prosecdef, pg_get_functiondef(oid) FROM pg_proc WHERE proname='is_internal_test_email' AND pronamespace='public'::regnamespace;
-- 3. the claims status check and the status values in use
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='claims_status_check';
SELECT status, ready_for_bids, count(*) FROM public.claims GROUP BY 1,2 ORDER BY 1,2;
-- 4. baseline size (rows the seed will write) and the product codes in use
SELECT count(*) FROM public.hover_orders WHERE homeowner_stripe_payment_intent_id IS NOT NULL AND requested_by_contractor_id IS NULL AND COALESCE(requested_by_role,'homeowner')='homeowner' AND product_code IS DISTINCT FROM 'roof_upgrade_detailed';
SELECT product_code, requested_by_role, count(*) FROM public.hover_orders GROUP BY 1,2 ORDER BY 1,2;
SELECT count(*) FROM public.claims WHERE ready_for_bids IS TRUE AND status IN ('active','bidding');
-- 5. nothing named owner_alerts exists yet
SELECT to_regclass('public.owner_alerts'), (SELECT count(*) FROM pg_proc WHERE proname LIKE 'owner_alert%');
-- 6. pg_cron version (the '30 seconds' schedule needs 1.5 or later; #1022 recorded 1.6.4 on 2026-08-18) and the Vault secret the job reads
SELECT extversion FROM pg_extension WHERE extname='pg_cron';
SELECT count(*) FROM vault.decrypted_secrets WHERE name='cron_service_role_key';           -- expect 1 (the value is never selected)
-- 7. existing jobs, to confirm the name is free
SELECT jobname, schedule FROM cron.job ORDER BY jobname;
```
If check 6 shows a pg_cron older than 1.5: do not apply the cron file as written; put it on #3428 (the closes-on says 60 seconds and a one-minute cron plus run time can miss it) and wait for Marty.

## Not verified by the author, for Marty
1. Check 1-7 above against production (no database connection in the build lane).
2. `TWILIO_PHONE_NUMBER` is a number that can place VOICE calls (the repo uses it for SMS). Twilio console > Phone Numbers > Capabilities: Voice on. If it is SMS-only, name the voice-capable existing number to use and set `TWILIO_PHONE_NUMBER` accordingly (a change of that secret also changes the number send-sms falls back to, so prefer a separate secret name if the numbers differ: say so on the PR).
3. The Twilio account may call the owner's number (trial accounts only call verified numbers; geographic permissions for US voice).
4. Secrets to create, by name only (the builder created none): `OWNER_ALERT_PHONE` (new). Already used by other functions: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `SENTRY_DSN` (Sentry reporting no-ops to console while the DSN is unset, #709).
5. Dustin's phone: the caller number set as an emergency-bypass contact (his step, Marty stages the ask once the caller number is known).
6. Supabase branch run (`migration-author-code` Step 6): not done by the builder (cost prompt). The throwaway-Postgres proof covers the SQL logic on Postgres 16, not the Supabase platform (Vault, pg_net, default privileges are modelled, not real).

## How to apply
1. Run the schema file ALONE with `psql -v ON_ERROR_STOP=1 -f` (it carries its own `BEGIN ... COMMIT`; never wrap it in an outer transaction). Re-read checks 4 and 5, then:
```sql
SELECT status, count(*) FROM public.owner_alerts GROUP BY 1;                    -- baseline rows only, no pending
SELECT has_function_privilege('anon', 'public.owner_alert_claim_batch(integer,interval,interval,integer)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.owner_alert_claim_batch(integer,interval,interval,integer)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.owner_alert_claim_batch(integer,interval,interval,integer)', 'EXECUTE');   -- false, false, true
```
2. Deploy `owner-alert-sweep` (config.toml already sets `verify_jwt = false`; the handler refuses all but the service-role key). Set `OWNER_ALERT_PHONE`. Until the secrets exist the function answers 503 and leases nothing.
3. Negative control before scheduling: POST the function with the anon key (expect 401/403, no call), then with the service-role key while `owner_alerts` holds only baseline rows (expect `leased=0`, no call).
4. Apply the cron file alone. Read `SELECT jobname, schedule FROM cron.job WHERE jobname='gh3428-owner-alert-sweep'` (expect `30 seconds`).
5. Production-like test (Marty's, after apply): the closes-on asks for a TEST-FLAGGED purchase to ring, but this design suppresses every is_test event (Ben's negative control). See the question on #3428; the sweep as built needs an unflagged, staff-controlled purchase or a decision to add a drill path.

## Rollback and monitoring
Stop the calls at once: rollback section 1 (`cron.unschedule`). Remove everything: section 2 (deletes `owner_alerts`, the call log; no other table is touched). Rollback is safe to run twice. Watch for 30 minutes after the cron file: Sentry events for `owner-alert-sweep`, `SELECT status, count(*) FROM public.owner_alerts GROUP BY 1`, and `cron.job_run_details` for the job (every run `succeeded`). Roll back if any `failed_final` appears for an event that should have rung, or if a call is placed for a staff test.

## Danger-pattern check
No NOT NULL column on an existing table; no DROP/RENAME/TRUNCATE/CASCADE on existing objects; no index on an existing table; the only new objects are a table (empty plus baseline rows) and functions. Pattern 9 (new public functions): all three functions `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`, with `has_function_privilege` probes in the proof (anon and authenticated also fail a live call under `SET ROLE`). Lock: the baseline INSERTs take ROW EXCLUSIVE on `owner_alerts` only and read `hover_orders` / `claims` under ACCESS SHARE (blocks no writer). Each sweep tick reads the same way and carries `statement_timeout = 8s`.
