<!--
STATUS (gh-1438, as of 2026-10-30T18:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3257_get_my_referrals_privacy (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3257; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3257_get_my_referrals_privacy

Issue #3257 (P18), Dustin's ruling "Match the policy (Recommended)" (2026-10-30), from LEGAL-READ 6527333555 on PR #3255. R-134 protective-only (shows the referrer less). Body-only function replace: same signature, same grants. Stacked on `gh3241_get_my_referrals_opt_out` (PR #3255). Needs REVIEW + LEGAL-READ + the R-177 pair; CTO applies after R-097.

## What it changes
On top of gh3241 (opted-out `display_name` = NULL):
- `status` = NULL for an opted-out referral (same opt-out test as gh3241: any linked claim from either side, or `referrals.metadata.referrer_updates_opt_out = true`; NULL is not an opt-out).
- `job_value` = NULL for every row. The column is kept so `CREATE OR REPLACE` keeps the ACL and the rollback is exact; dropping it would need `DROP FUNCTION` + `CREATE` (grants recreated, a window with no function, and clients naming the column break).
- Fee fields (`commission_amount`, `commission_paid_at`, `recruit_commission_amount`, `recruit_paid_at`) unchanged for every row.

`referrals.status` is `NOT NULL DEFAULT 'clicked'` (0 NULL rows), so a NULL `status` in this result means exactly "updates declined". The dashboards in the same PR use that signal.

## Live state read (2026-10-30, read-only)
- `get_my_referrals()` prosrc md5 = `e63684bf6ce7d5b2da454ee00b31a9e9` (gh3217a; gh3241 not yet applied).
- `referrals.status`: NOT NULL, default `'clicked'`; 0 NULL rows; values in use `clicked, job_completed, registered`.
- 1 referral has a non-NULL `job_value`; 0 referrals are linked to an opted-out claim (so today only the `job_value` change is visible).
- `authenticated` still has column SELECT on `referrals (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)` and the "Agents can read own referrals" policy, so a partner can still read `status` and `job_value` straight from the table. This migration does not change that (see the PR's open item).

## Guard (re-run before apply)
```sql
select md5(prosrc) from pg_proc where oid = 'public.get_my_referrals()'::regprocedure;
-- must be 358ef8ae03a472b546d6ffa7e791d263 (the gh3241 body). e63684bf... means gh3241 is not applied yet: apply it first.
-- Anything else: stop and rebase this draft.
select count(*) from referrals where status is null;  -- must be 0 (NULL status is the "updates declined" signal)
```
After apply: `md5(prosrc)` = `825528f4db6b5ba46b7936adf0149df7`.

## Apply
Single transaction as `postgres`, after gh3241. Deploy the dashboards (this PR) with or before it: the current pages render a NULL status as a blank or "Pending" badge and a NULL job value as "—", so nothing breaks either way, but only the new pages show "Referral #N — updates declined".

## Verify (closes-on)
As an is_test partner: `select count(*) filter (where job_value is not null) from get_my_referrals()` = 0, and an opted-out is_test referral returns `status` NULL while an opted-in one keeps its status (beside today's output, the negative control). The proof's P1-P6 / J1-J3 do exactly this.

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3257_get_my_referrals_privacy_proof_run.sh --mutations` (PostgreSQL 16.15): the gh3217a md5 equals production; the baseline (gh3217a + gh3241) md5 equals the guard; BEFORE fails 8/19 (P1-P4, J1-J3, S3) while the opted-in control and the fee checks pass; AFTER / RERUN / REAPPLIED pass 19/19; ROLLBACK restores the catalog snapshot and the gh3241 md5; 13/13 mutants killed.

## Rollback
`gh3257_get_my_referrals_privacy_rollback.sql` re-creates the gh3241 body and grants exactly. Opted-out statuses and every row's `job_value` are returned again.
