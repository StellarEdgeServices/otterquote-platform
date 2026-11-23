# gh-3374 pre-flight (second bump): agreement version label v3-2026-11 to v4-2026-11 (Tier 3B, R-097 24-hour notice, R-177 pair, Dustin's GO)

Forward: `supabase/migrations_drafts/gh3374_agreement_version_bump_v4.sql`. Rollback: `supabase/migrations_rollbacks/gh3374_agreement_version_bump_v4_rollback.sql`.
Proof: `supabase/tests/gh3374_agreement_version_bump_v4_proof.sql` (runner `..._v4_proof_run.sh`, throwaway Postgres only). Not applied; nothing in this PR touches production.

## What the change does
Updates the single row of `public.agreement_version_current` from `v3-2026-11` to `v4-2026-11`. `accept_cpa()` already reads that row, so the next FIRST acceptance is stamped `v4-2026-11`. Rows touched: 1. No backfill: contractors already stamped keep their value. Money: none.
Consent: the label records which legal text a contractor accepted. This changes the label future acceptances are recorded under, not any consent wording and not any existing record. The label string and the apply need Dustin's word (ASK on #3374).

## Why (scope, #3374 comment 6993956936)
The label covers the Terms as well as the Agreement. Visible Terms/Privacy text merged since the v3-2026-11 bump (2026-11-05): #3713 Terms 15.5 (2026-11-18), #3794 Terms 8.5 (2026-11-19T12:36:14Z), #3718 Privacy 14 (2026-11-19T12:40:38Z). One bump batches them.

## Read-only checks before the apply (all SELECTs)
```sql
SELECT version_label, set_at FROM public.agreement_version_current;               -- expect one row: v3-2026-11
SELECT position('agreement_version_current' in pg_get_functiondef('public.accept_cpa(text)'::regprocedure)) > 0;   -- expect true
SELECT status, is_test, agreement_version, count(*) FROM public.contractors GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT version_label FROM public.cpa_versions WHERE is_current;                   -- expect v1-2026-04
SELECT count(*) FROM public.contractors WHERE NOT is_test AND agreement_accepted_at IS NOT NULL;   -- STOP condition: must be 0 (see below)
```
Read by the author on 2026-11-19 (project yeszghaspzwwstvsrioa): label `v3-2026-11` set 2026-11-05 18:07:45Z; `accept_cpa()` reads the source: true; CPA version `v1-2026-04`; non-test contractors: 1, `pending_approval`, agreement_version NULL; non-test contractors with an acceptance: 0.

## Order and stop condition
1. #3794 and #3718 live on the published site (live fetch of `/terms.html` and `/privacy.html`), so no acceptance is recorded under a label whose text is not on the page.
2. Apply before any real contractor accepts. STOP and go to Dustin if a non-test contractor already has an acceptance: it would be stamped `v3-2026-11`, which this change cannot repair, and a later Agreement change then takes the 30-day Section 18.1 route (Ben ruling, #3374 comment 6840585571).
3. Apply the forward file once. It refuses with 55000 on any other starting label and is a no-op if already applied.

## After the apply (read-only)
```sql
SELECT version_label FROM public.agreement_version_current;                       -- expect v4-2026-11
```
Closes-on (#3374): a new acceptance recorded under the new label. Verify on an `is_test` contractor (accept_cpa then read `agreement_version`/`cpa_version`), then on the first real contractor.

## Danger patterns (migration-author-code Step 1)
1-8: not triggered (no column, index, rename, truncate, delete or cascade; one-row UPDATE, guarded). 9 (new public function): not triggered, no function is created or replaced.

## Rollback
Run the rollback file. It restores `v3-2026-11` and does not rewrite any contractor already stamped `v4-2026-11`.
