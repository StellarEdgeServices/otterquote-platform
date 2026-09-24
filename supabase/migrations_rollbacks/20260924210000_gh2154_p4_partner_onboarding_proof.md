# SQL Proof: gh-2154 P-4 partner onboarding ledger + cron migrations

**Migrations proved**: `20260924210000_gh2154_p4_partner_onboarding_ledger.sql`,
`20260924211500_gh2154_p4_partner_onboarding_cron.sql`
**Rollbacks proved**: `20260924210000_gh2154_p4_partner_onboarding_ledger_rollback.sql`,
`20260924211500_gh2154_p4_partner_onboarding_cron_rollback.sql`
**Project**: `yeszghaspzwwstvsrioa` (prod)
**Method**: Supabase MCP `execute_sql`, one call, `BEGIN` ... `ROLLBACK`. Nothing
in this proof is applied to prod — verified explicitly below (post-rollback
read-back).

## 1. Baseline (before, read-only)

```sql
SELECT to_regclass('public.partner_onboarding_sends') AS table_exists_before,
       (SELECT count(*) FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep') AS cron_rows_before;
```
Result: `table_exists_before: null, cron_rows_before: 0` — clean baseline, no
pre-existing collision.

## 2. Single transaction: apply, assert, rollback, assert (one `execute_sql` call)

```sql
BEGIN;

-- ledger migration DDL body (verbatim from the migration file)
CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends ( ... );
CREATE INDEX IF NOT EXISTS partner_onboarding_sends_partner_id_idx ON public.partner_onboarding_sends (partner_id);
COMMENT ON TABLE public.partner_onboarding_sends IS '...';
ALTER TABLE public.partner_onboarding_sends ENABLE ROW LEVEL SECURITY;

-- cron migration DDL body (verbatim from the migration file)
SELECT cron.schedule(
  'gh2154-p4-partner-onboarding-sweep',
  '*/15 * * * *',
  $cron$ SELECT net.http_post( url := '.../functions/v1/send-partner-onboarding', ... ); $cron$
);

-- PROOF 1: migration applied
DO $$ BEGIN
  ASSERT (SELECT to_regclass('public.partner_onboarding_sends')) IS NOT NULL,
    'PROOF FAILED: ledger table missing after apply';
END $$;

-- PROOF 2: cron job registered with the right command
DO $$
DECLARE v_command text; v_schedule text; v_active boolean;
BEGIN
  SELECT command, schedule, active INTO v_command, v_schedule, v_active
  FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep';
  ASSERT v_command IS NOT NULL, 'PROOF FAILED: cron job not registered';
  ASSERT v_schedule = '*/15 * * * *', 'PROOF FAILED: wrong schedule';
  ASSERT v_command LIKE '%send-partner-onboarding%', 'PROOF FAILED: wrong function URL';
  ASSERT v_command LIKE '%cron_service_role_key%', 'PROOF FAILED: wrong auth secret name';
END $$;

-- apply the rollback (body, verbatim), reverse order
SELECT cron.unschedule('gh2154-p4-partner-onboarding-sweep');
DROP TABLE IF EXISTS public.partner_onboarding_sends;

-- PROOF 3: rollback removed both, inside the same transaction
DO $$ BEGIN
  ASSERT (SELECT to_regclass('public.partner_onboarding_sends')) IS NULL,
    'PROOF FAILED: table still exists after rollback';
  ASSERT NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep'),
    'PROOF FAILED: cron job still exists after rollback';
END $$;

ROLLBACK;
```

**Outcome**: the call completed successfully through to the final
`cron.unschedule` statement (`{"unschedule": true}`), which is only reachable
if PROOF 1 and PROOF 2's `ASSERT`s both passed — a failed `ASSERT` raises and
aborts the transaction before any later statement runs, and the tool would
have returned an error instead of a clean result. PROOF 3 then ran after the
rollback DDL, inside the same still-open transaction, and also did not raise.

## 3. Read-back (after, read-only, separate call — confirms the assumption the task named explicitly)

```sql
SELECT to_regclass('public.partner_onboarding_sends') AS table_exists_after,
       (SELECT count(*) FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep') AS cron_rows_after;
```
Result: `table_exists_after: null, cron_rows_after: 0`.

**This is the explicit verification the task asked for**: pg_cron's
`cron.schedule()` writes a normal row into `cron.job` (no autonomous
transaction, no background-worker side channel) — it rolled back exactly
like the `CREATE TABLE` in the same transaction did. Nothing from step 2
persisted to prod.

## Conclusion

- The ledger migration applies cleanly (table + index + comment + RLS-enable).
- The cron migration registers the job with schedule `*/15 * * * *` and a
  command that calls `send-partner-onboarding` using the `cron_service_role_key`
  vault secret, matching the repo's existing cron-job pattern.
- Both rollbacks remove exactly what their forward migrations added.
- The whole exercise ran inside one rolled-back transaction and left prod
  byte-for-byte as it was beforehand (confirmed by the separate read-back).
