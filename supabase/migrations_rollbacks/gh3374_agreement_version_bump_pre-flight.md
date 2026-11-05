# gh-3374 pre-flight: agreement version label bump (Tier 3B, R-097 24-hour notice, R-177 pair)

Forward: `supabase/migrations_drafts/gh3374_agreement_version_bump.sql`. Rollback: `supabase/migrations_rollbacks/gh3374_agreement_version_bump_rollback.sql`.
Proof: `supabase/tests/gh3374_agreement_version_bump_proof.sql` (runner `..._run.sh`, throwaway Postgres only). The author made no production read; every query below is for the applier.

## What the change does
Updates the single row of `public.agreement_version_current` from `v2-2026-10` to `v3-2026-11`. `accept_cpa()` already reads that row (gh-3073, applied 2026-10-29), so the next first acceptance is stamped with the new label. Money: none. Consent: it changes the label a new acceptance is recorded under, not any consent wording.

## Read-only checks before the apply (all SELECTs)
```sql
-- 1. the source row is the expected old label
SELECT version_label, set_at FROM public.agreement_version_current;                 -- expect one row: v2-2026-10
-- 2. accept_cpa() still reads the source (gh-3073 body live)
SELECT position('agreement_version_current' in pg_get_functiondef('public.accept_cpa(text)'::regprocedure)) > 0;   -- expect true
-- 3. who is stamped with what, and who is waiting (non-test only matters)
SELECT status, is_test, agreement_version, count(*) FROM public.contractors GROUP BY 1,2,3 ORDER BY 1,2,3;
-- 4. the CPA version is untouched by this change
SELECT version_label FROM public.cpa_versions WHERE is_current;                      -- expect v1-2026-04
```
## Order
1. PR #3400 merged and the Central Time wording live on `/contractor-agreement.html` (live fetch), so the new label never covers text that is not on the page.
2. The apply below, before the pending non-test contractor accepts anything (a contractor who accepts between the page going live and the apply is stamped `v2-2026-10`, which is the gap this issue closes).
3. Apply the forward file once. It refuses with 55000 on any other starting label and is a no-op if already applied.

## After the apply (read-only)
```sql
SELECT version_label FROM public.agreement_version_current;                           -- expect v3-2026-11
```
Closes-on (issue #3374): a new acceptance recorded under the new label. Verify on an `is_test` contractor: after `accept_cpa('v1-2026-04')` the row reads `agreement_version = v3-2026-11`, `cpa_version = v1-2026-04`. Then, after the real contractor accepts, the same two columns on that row.

## Rollback
Run the rollback file. It restores `v2-2026-10` and does not rewrite any contractor already stamped `v3-2026-11`.
