# Pre-flight: gh3497_quotes_refuse_rate_mismatch (Tier 3B, DRAFT)

NOT APPLIED. Refs #3497 (found by LEGAL-READ 6675181967 on PR #3491). Apply only through the Tier 3B path: review, R-177 if the gate is red, `tier:3b-approved` after the R-097 24-hour notice, a recorded apply. The authoring session applied it nowhere except a throwaway local Postgres 16.

## What it does
Adds `public.quotes_check_displayed_fee_rate()` and a `BEFORE INSERT ... FOR EACH ROW` trigger of the same name on `public.quotes`. For a client caller (`current_user IN ('anon','authenticated')`, `auth.role() <> 'service_role'`, not an admin) whose new quote carries a `platform_fee_pct` that differs from `quotes_platform_fee_for(contractor_id, claim_id).fee_pct`, the insert is refused: SQLSTATE `P0001`, message starting `quotes: fee_rate_mismatch:`. Nothing else changes. No table, policy, grant or data change.

## What it deliberately leaves alone
- `service_role`, admins and owner-level SECURITY DEFINER sessions. `process-auto-bids` runs as `service_role` and sets its own rate, so it is not checked.
- A client insert with `platform_fee_pct` NULL (no displayed rate): not refused; the guard stores the configured rate as today.
- A client insert with no applicable config row: this trigger steps aside and the guard refuses it with its own message.
- UPDATE (the guard already keeps the stored rate; CEO ruling 6050104316).

## Before applying (read-only)
```sql
-- gh2519 is live: the function this reads exists and the guard carries gh-2519
SELECT to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NOT NULL AS fee_fn,
       (SELECT prosrc LIKE '%gh-2519%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure) AS guard_has_2519;
-- this trigger is not already there
SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_check_displayed_fee_rate' AND NOT tgisinternal;   -- 0
-- the BEFORE INSERT row triggers and their firing order (name order, C collation); the new one must come before the guard
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND NOT tgisinternal AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 ORDER BY tgname COLLATE "C";
-- the configured rate is what the forms show: one row, 5.00 at 2026-11-05
SELECT id, state, trade, fee_pct, fee_basis, effective_date FROM public.platform_fee_config ORDER BY state NULLS LAST, trade NULLS LAST;
```
The migration also checks the first two itself and rolls back if either fails, and checks the firing order at the end.

## After applying
```sql
SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_check_displayed_fee_rate';
-- expect tgenabled O, BEFORE INSERT ... FOR EACH ROW
```
Then, in a ROLLBACK block on an `is_test` claim, as a contractor session: insert with `platform_fee_pct` equal to the configured rate (accepted) and with a different one (refused P0001 `fee_rate_mismatch`), per `supabase/tests/gh3497_quotes_refuse_rate_mismatch_proof.sql`.

## Order of rollout and the standing CONDITION on #3497
No insert into or `fee_pct` update on `platform_fee_config` until BOTH are live: (1) part 1, both bid forms reading `rpc('quotes_platform_fee_for')` and stopping with no answer (the PR this file ships in), deployed; (2) this trigger, applied. Either may land first. If this lands first and the rate is later changed before part 1 is deployed, the old forms (which show 5.00) are refused with the mismatch error, none silently charged; a browser tab loaded before part 1 deployed behaves the same until reloaded.

## Failure mode (what happens to a refused bid)
The refusal is an exception inside the INSERT: no quote row, and the forms insert `fee_acceptances` only after the quote insert succeeds, so no acceptance row. The form shows the error through its existing "Error submitting bid:" message, keeps every entry, unlocks, re-reads the rate and clears the acceptance so the contractor re-accepts the configured figure and resubmits. Watch after apply: Sentry / `postgres` logs for `fee_rate_mismatch` (each is a contractor who was shown a stale rate; expected at a rate change, otherwise a sign of a cached or broken form).

## Proof
`supabase/tests/gh3497_quotes_refuse_rate_mismatch_proof_run.sh` (throwaway Postgres 16: repo throwaway schema, then gh2626, gh2519, gh2564): P1 before (the hole is open: displayed 5.00, configured 7.50, stored 7.50 / $1,875.00, accepted), P2 after (refused), P3 after the rollback (equals P1), P4 re-applied (equals P2). Control: the trigger renamed to fire after the guard leaves the hole open.

## Rollback
`supabase/migrations_drafts/gh3497_quotes_refuse_rate_mismatch_rollback.sql` (DROP TRIGGER, DROP FUNCTION). No data lost.
