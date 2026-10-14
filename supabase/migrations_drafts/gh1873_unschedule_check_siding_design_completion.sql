-- STATUS (gh-1438, as of 2026-10-13T22:44:46Z): NOT APPLIED
-- FILE ROLE: forward file of set gh1873_unschedule_check_siding_design_completion (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: pg_cron job 6 `check-siding-design-completion` (*/30 * * * *, active) read by name and schedule only on #1873 comment 6051733882 (2026-10-08); not re-measured since; no ledger row for this set
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-1873 step 2 (Hover retirement): unschedule the pg_cron job that calls the check-siding-design-completion Edge Function.
--
-- Why: that function released retail-siding bids once the homeowner finished a Hover design. Hover is retired (Dustin,
-- #2382: "Retire them now. We aren't using hover") and the function is a disabled stub after this PR's code change, so the job
-- has nothing left to do. Left scheduled it would post a request every 30 minutes to a stub forever.
--
-- Change (Tier 3B: a live scheduled job on a notification path): remove ONE cron job, by name.
--   cron.unschedule(jobid) for jobname = 'check-siding-design-completion'. A no-op if the job is already absent.
-- Not changed: cron job 10 `process-hover-rebate-scan` and trigger `after_claim_completed_rebate`. They run the homeowner
-- measurement-fee REFUND engine (process-hover-rebate, D-181 / D-205 / D-291) and have nothing to do with Hover's API.
-- Unscheduling job 10 would stop a homeowner refund (hover_orders has one unpaid rebate_due row, 2026-10-08). THIS FILE MUST NOT TOUCH IT.
-- Not changed: the claims.*_bid_released_at columns, hover_orders, hover_tokens, any data.
--
-- Consequence to rule on BEFORE apply (Tier C, #1873 section D question 1, owed to Ben): with the job gone, nothing releases a
-- retail-siding claim's bids (today's release rule is "the homeowner finished a Hover design"). Measured 2026-10-08: `claims` with
-- siding in trades = 2, awaiting release 0, released 0, so nobody is waiting today.
--
-- Order: deploy the platform-health-check change from this PR first (it stops expecting job 6), then the stubs, then apply this file
-- under an R-097 24-hour notice (Marty posts it; the window starts only when posted).
--
-- Rollback: supabase/migrations_rollbacks/gh1873_unschedule_check_siding_design_completion_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh1873_unschedule_check_siding_design_completion_pre-flight.md
-- NOT APPLIED by the authoring session. Apply only after REVIEW and the R-097 window.

BEGIN;

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'check-siding-design-completion';

COMMIT;
