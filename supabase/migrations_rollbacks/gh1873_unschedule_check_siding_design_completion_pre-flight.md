# Pre-flight: gh1873_unschedule_check_siding_design_completion (Tier 3B, NOT APPLIED)

Draft authored 2026-10-13T22:44:46Z (stamp.py) under gh-1873. Nothing here has been run.

## What the forward file does
`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'check-siding-design-completion'` inside one transaction. One job, by name.

## Read-only checks before apply (SELECT only)
1. `SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname IN ('check-siding-design-completion','process-hover-rebate-scan') ORDER BY jobid;`
   Expect two rows: job 6 `*/30 * * * *` active, job 10 `*/30 * * * *` active. Job 10 must still be there after the apply.
2. Pre-image for rollback (record it in the apply session, do not paste a token): `SELECT md5(command), length(command) FROM cron.job WHERE jobname = 'check-siding-design-completion';`
   Compare to the rollback file's command (same two numbers) before relying on the rollback as written.
3. `SELECT count(*) FROM claims WHERE 'siding' = ANY(trades::text[]) AND siding_bid_released_at IS NULL AND status NOT IN ('completed','cancelled');`
   (adjust the trades predicate to the column's real type). Expect 0 awaiting release; a non-zero count means a siding claim is waiting on the old Hover gate: stop and ask Ben.
4. `SELECT count(*) FROM cron.job_run_details WHERE jobid = 6 AND start_time > now() - interval '2 days' AND status = 'failed';` for context only.

## After apply
- Rerun check 1: expect exactly one row (job 10). Rerun nothing else.
- platform-health-check must already be deployed without the job 6 entry (see the PR), or it raises a stale-cron alert within 45 minutes.

## Blast radius
Retail-siding bid release stops being automatic (see the Tier C question in the forward file's header). No refund, payment, notification-to-homeowner or contractor-facing change.

## Rollback
`supabase/migrations_rollbacks/gh1873_unschedule_check_siding_design_completion_rollback.sql`, plus a redeploy of the old function from git history.
