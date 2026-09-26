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

## Conclusion (original schema, superseded by the re-run below — kept for history)

- The ledger migration applies cleanly (table + index + comment + RLS-enable).
- The cron migration registers the job with schedule `*/15 * * * *` and a
  command that calls `send-partner-onboarding` using the `cron_service_role_key`
  vault secret, matching the repo's existing cron-job pattern.
- Both rollbacks remove exactly what their forward migrations added.
- The whole exercise ran inside one rolled-back transaction and left prod
  byte-for-byte as it was beforehand (confirmed by the separate read-back).

---

## RE-RUN after Kevin's corrections (Q1 opt-out column, Q3 claim/pending/failed schema)

The ledger migration's schema changed materially: `status` CHECK widened to
`('pending', 'sent', 'failed', 'skipped')`, a new `error` column, a new
`claim_partner_onboarding_stage(uuid, text, integer)` SECURITY DEFINER
function (the atomic conditional-upsert claim), and a new nullable
`referral_agents.onboarding_opted_out_at` column. Re-proved in full, same
method, same project.

### Baseline (before, read-only)

```sql
SELECT to_regclass('public.partner_onboarding_sends') AS table_exists_before,
       (SELECT count(*) FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep') AS cron_rows_before,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='referral_agents' AND column_name='onboarding_opted_out_at') AS opted_out_col_before,
       (SELECT count(*) FROM pg_proc WHERE proname = 'claim_partner_onboarding_stage') AS claim_fn_before;
```
Result: `table_exists_before: null, cron_rows_before: 0, opted_out_col_before: 0, claim_fn_before: 0` — clean baseline.

### Single transaction: apply both migration bodies, assert schema + cron + the
### claim function's own conditional-upsert behavior, apply both rollback
### bodies, assert everything is gone, `ROLLBACK`

The new claim-function proof (PROOF 3) is the discriminating one — it doesn't
just check the function exists, it CALLS it three times against a real
`referral_agents` row inside the transaction and asserts the exact behavior
`onboarding-stage.ts`'s `canClaimStage()` mirrors in JS:
  1. First claim on a fresh (partner, 'day0') pair → `true` (claimed).
  2. Second claim immediately after, same row still `'pending'` and fresh →
     `false` (refused — this is what stops a concurrent double-send).
  3. After forcing the row's `created_at` back 21 minutes (past the
     20-minute `STALE_PENDING_MINUTES` window) → `true` (reclaimable — this
     is what lets a crashed/never-completed run's stage be retried).

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends ( ... status CHECK (status IN ('pending','sent','failed','skipped')) ..., error text, ... );
CREATE INDEX IF NOT EXISTS partner_onboarding_sends_partner_id_idx ON public.partner_onboarding_sends (partner_id);
CREATE OR REPLACE FUNCTION public.claim_partner_onboarding_stage(p_partner_id uuid, p_stage text, p_stale_minutes integer DEFAULT 20) RETURNS boolean ... ;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM PUBLIC, anon, authenticated;
ALTER TABLE public.referral_agents ADD COLUMN IF NOT EXISTS onboarding_opted_out_at timestamptz;
ALTER TABLE public.partner_onboarding_sends ENABLE ROW LEVEL SECURITY;
SELECT cron.schedule('gh2154-p4-partner-onboarding-sweep', '*/15 * * * *', $cron$ SELECT net.http_post(...); $cron$);

-- PROOF 1: schema applied (table, column, function all exist)
-- PROOF 2: cron job registered, schedule + command correct
-- PROOF 3: claim/refuse/reclaim, exactly as above, against a real referral_agents row

SELECT cron.unschedule('gh2154-p4-partner-onboarding-sweep');
DROP FUNCTION IF EXISTS public.claim_partner_onboarding_stage(uuid, text, integer);
DROP TABLE IF EXISTS public.partner_onboarding_sends;
ALTER TABLE public.referral_agents DROP COLUMN IF EXISTS onboarding_opted_out_at;

-- PROOF 4: rollback removed the table, the function, the cron job, AND the column

ROLLBACK;
```

**Outcome**: the call completed through to `{"unschedule": true}` — only
reachable if PROOFs 1–3 (schema, cron, and all three claim-function
assertions) passed; a failed `ASSERT` aborts before that statement runs.
PROOF 4 then ran, inside the same still-open transaction, after the rollback
DDL, and also did not raise.

### Read-back (after, read-only, separate call)

```sql
SELECT to_regclass('public.partner_onboarding_sends') AS table_exists_after,
       (SELECT count(*) FROM cron.job WHERE jobname = 'gh2154-p4-partner-onboarding-sweep') AS cron_rows_after,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='referral_agents' AND column_name='onboarding_opted_out_at') AS opted_out_col_after,
       (SELECT count(*) FROM pg_proc WHERE proname = 'claim_partner_onboarding_stage') AS claim_fn_after;
```
Result: `table_exists_after: null, cron_rows_after: 0, opted_out_col_after: 0, claim_fn_after: 0`.

### Conclusion (current)

- The updated ledger migration applies cleanly: table (with the 4-state
  CHECK and new `error` column), index, the atomic claim function (with its
  EXECUTE correctly revoked from PUBLIC/anon/authenticated), RLS-enable, and
  the new `referral_agents.onboarding_opted_out_at` column.
- The claim function's conditional upsert behaves exactly as designed and as
  `canClaimStage()` mirrors in JS: first claim wins, a fresh pending claim is
  refused, a stale one is reclaimable — proved by CALLING it three times
  against a live row, not just checking it exists.
- The cron migration is unaffected by the schema change and still registers
  correctly.
- Both rollbacks remove exactly what their forward migrations added,
  including the new column and function.
- Nothing from this re-run persisted to prod (confirmed by the separate
  read-back, all four counters back to their baseline values).
