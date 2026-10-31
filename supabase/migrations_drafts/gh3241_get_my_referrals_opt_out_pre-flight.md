<!--
STATUS (gh-1438, as of 2026-10-30T16:30:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3241_get_my_referrals_opt_out (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3241; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3241_get_my_referrals_opt_out

Issue #3241 (P18), follow-up (b) of Ben's R-177 SIGNED on #3225 (6524259012). R-134 protective-only (shows the referrer less). Function replace with the same signature and grants. Needs REVIEW + LEGAL-READ (user-visible: an opted-out homeowner's name disappears from the partner dashboards) + the R-177 pair; CTO applies.

## What it changes
`get_my_referrals()` returns `display_name = NULL` for a referral whose homeowner opted out of updates to their referrer. A referral is opted out when any linked claim has `referrer_updates_opt_out = true` (linked from either side: `claims.referral_id = r.id` or `r.claim_id = claims.id`), or `referrals.metadata.referrer_updates_opt_out = true` (the fallback source `send-partner-status-email` already honours). NULL ("never asked") is not an opt-out: the name keeps showing. The row, its status and the partner's commission fields are unchanged. Everything else in the function (signature, SECURITY DEFINER, search_path, the masking rule, the auth.uid() scope, grants) is identical to the live definition.

Same PR, no migration: `send-partner-status-email` now reads the opt-out on every linked claim (it already withheld the series for an opt-out on the one claim it used); the decision is the pure `decideReferrerConsent()` in `consent.ts`. That function change ships with the normal EF deploy, which this PR does not do.

## Live state read (2026-10-30, read-only)
- `get_my_referrals()` body equals `gh3217a_get_my_referrals.sql` byte for byte (`md5(prosrc) = e63684bf6ce7d5b2da454ee00b31a9e9`, 1164 chars); proacl `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
- `claims.referrer_updates_opt_out`: boolean, nullable, no default. 3 claims opted out (all `is_test = false`); 0 referrals linked to an opted-out claim by either link (`referrals` has 1 row with `claim_id`, `claims` has 1 row with `referral_id`, the two agree). So 0 live rows change today, as Ben measured.
- Deployed `send-partner-status-email` (version 57) equals `index.ts`/`templates.ts`/`email-footer.ts` on main.

Re-run before apply:
```sql
select md5(prosrc) from pg_proc where oid = 'public.get_my_referrals()'::regprocedure;  -- must be e63684bf6ce7d5b2da454ee00b31a9e9; otherwise rebase this draft
select count(*) from referrals r where exists (select 1 from claims c where (c.referral_id = r.id or c.id = r.claim_id) and c.referrer_updates_opt_out)
   or r.metadata->'referrer_updates_opt_out' = 'true'::jsonb;  -- rows whose name will disappear (0 on 2026-10-30)
```

## Apply
Single transaction as `postgres`. Order relative to the EF deploy does not matter: each half only withholds more.

## Verify (closes-on)
As an is_test partner whose is_test referral's claim has `referrer_updates_opt_out = true`, `select display_name, status from get_my_referrals()` returns NULL and the status for that row; the same row with the flag false returns the masked name. The throwaway proof below does exactly this (O1 / O3).

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3241_get_my_referrals_opt_out_proof_run.sh --mutations` (run on PostgreSQL 16.15): the baseline is the live body (md5 checked), BEFORE fails 6/12 (negative control: opted-out names shown, O3 passes), AFTER / RERUN / REAPPLIED pass 12/12, ROLLBACK restores the catalog and the production prosrc md5, 9/9 mutants killed.

## Rollback
`gh3241_get_my_referrals_opt_out_rollback.sql` re-creates the live body and grants exactly. Opted-out homeowners' names show to referrers again.
