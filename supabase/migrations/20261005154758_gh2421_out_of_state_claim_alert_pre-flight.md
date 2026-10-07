# Pre-flight: 20261003130000_gh2421_out_of_state_claim_alert (Tier 3B)

NOT APPLIED. Refs #2421 (D-344), PR B. Nothing here has been run against a database; see "Not verified".

## What it does
Adds `claims.out_of_state_alerted_at` (nullable timestamptz), a guard trigger that stops client roles writing it, and
`trg_notify_admin_out_of_state_claim` (AFTER INSERT OR UPDATE OF property_state ON claims) which posts
`{event_type: "out_of_state_claim", record: {id}}` to `notify-admin-new-homeowner` with the vault service-role key.
The Edge Function decides eligibility, stamps the column atomically, and emails Dustin once.

## Danger-pattern check
- New nullable column, no default: metadata-only change on Postgres, brief ACCESS EXCLUSIVE lock on `claims`.
- No DROP, no RLS or policy change, no GRANT/REVOKE, no data change.
- Two new triggers on `claims`. The guard is BEFORE INSERT OR UPDATE (runs on every claim write; one comparison of `current_user`). The alert trigger is AFTER, filtered by a WHEN clause, and non-fatal (EXCEPTION WHEN OTHERS -> RAISE LOG, RETURN NEW).
- New SECURITY DEFINER function pinned `search_path = public, net, pg_temp`. The guard function is SECURITY INVOKER on purpose (it needs the caller's `current_user`).

## Apply order
1. Deploy the Edge Function (`notify-admin-new-homeowner`). With no trigger yet nothing posts the new event.
2. Apply this migration. If applied first, the old Edge Function answers 400 and that claim's alert is lost until its next property_state write.

## Verify after apply (read-only)
- `SELECT column_name FROM information_schema.columns WHERE table_name='claims' AND column_name='out_of_state_alerted_at'` returns a row.
- `SELECT tgname FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname IN ('trg_notify_admin_out_of_state_claim','trg_claims_guard_out_of_state_alerted_at')` returns two rows.
- Closure check from the issue: a test-homeowner claim is excluded by design, so use a real-looking non-test account with `property_state='WA'` (then delete it) or watch for the first real out-of-state claim; FL must produce no alert.

## Rollback
`supabase/migrations_rollbacks/20261003130000_gh2421_out_of_state_claim_alert_rollback.sql`. Stops the alerts immediately; the Edge Function can stay deployed.

## Not verified
No database was available to this author. The SQL parses cleanly (pglast, syntax only: 13 statements forward, 7 rollback) but has not been executed, and the guard and alert triggers have not been exercised against a Supabase branch. Run it on a branch first (per the migration-author protocol) before the 24-hour window closes.
