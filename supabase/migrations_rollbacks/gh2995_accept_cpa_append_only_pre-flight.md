# gh-2995 pre-flight: append-only contractor CPA acceptance, accept_cpa(p_version text)

Tier 3B, consent-path code (part b of #2444). NOT APPLIED. Needs: R-177 pair, migration-author review, R-097 24-hour notice, then a recorded apply. The page change in the same PR MUST NOT ship before the migration is applied (the pages would call a function that does not exist and every acceptance would fail with the existing error copy).

## What changes
1. New table `public.contractor_cpa_acceptances` (id, contractor_id FK contractors ON DELETE RESTRICT, user_id, agreement_version CHECK `^v[0-9]+-[0-9]{4}-[0-9]{2}$`, kind first|reaccept, accepted_at default now(), accepted_ip, accepted_ua, is_test). RLS on; policies: SELECT own rows (`user_id = auth.uid()`) and SELECT for the admin email (same literal as `cpa_versions_admin_update`). Grants: SELECT to authenticated only; nothing to anon or PUBLIC. A BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE trigger raise 42501 for every role, the owner included.
2. New function `public.cpa_acceptances_append_only()` (the trigger body).
3. New `public.accept_cpa(p_version text) RETURNS jsonb`, SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and anon, granted to authenticated. One transaction: gate `p_version` against the single `cpa_versions.is_current` row (22023 otherwise, same gate as gh-2443); lock the caller's own contractors row (`user_id = auth.uid()`, unique); read IP (`x-forwarded-for` first element, then `cf-connecting-ip`, `x-real-ip`) and user agent from `request.headers` exactly as `record_cpa_ip()` does; INSERT the acceptance row; UPDATE contractors (cpa_version, cpa_accepted_at = server now(), needs_cpa_reattestation = false, agreement_version = the version id, agreement_accepted_at on a first acceptance only); INSERT the activity_log `cpa_accepted` row with metadata (acceptance_id, agreement_version, kind, accepted_ip, accepted_ua) and is_test from contractors.is_test.
`record_cpa_ip()` and `contractors_freeze_privileged_columns()` are NOT touched.

## Consent scope (no new user-facing wording)
The only strings the function writes into a user-visible surface are the two activity_log titles the pages write today, byte for byte: `Accepted Contractor Partner Agreement (<version>)` for a first acceptance and `Accepted updated Contractor Partner Agreement (<version>)` for a re-acceptance. Page error copy is unchanged (first modal: `Error accepting agreement. Please try again.` / React `C.cpaReacceptModal.errorGeneric`; re-accept: `Error saving agreement acceptance. Please try again.` / `m.errorSave`). The version id `v1-2026-04` is read from `cpa_versions`, not hard-coded in the function.

## Behaviour changes the reviewers should see
- `contractors.agreement_version` becomes the version id (was today's date). Readers of that column: none found in the pages touched here; a column comment in `sql/v89-contractors-public-view.sql` lists it as exposed; confirm no consumer parses it as a date.
- Timestamps become server-side (transaction `now()`), not the browser clock.
- The three browser writes become one transaction: any failure rolls back the record, the contractors update and the log row together (proof C7).
- A first acceptance is `contractors.agreement_accepted_at IS NULL`; every other call is a `reaccept`. A repeat call with the current version appends another record (append-only means a double submit is a second row; the pages keep their in-flight button guard).
- Rows already accepted before this change have NO row in the new table. This migration does not backfill (a backfill would manufacture consent evidence with invented IP/UA); their history stays in `contractors.ic_24511_attestation` and `activity_log`.
- `ON DELETE RESTRICT`: a contractor row that has acceptance records cannot be hard-deleted without first dealing with the records, and the append-only trigger refuses deleting them. Any purge script for test contractors (see `sql/2026-07-13-purge-summit-ridge-543-rollback.sql` for the pattern) must be reviewed before apply. A superuser can still `ALTER TABLE ... DISABLE TRIGGER`; the table is append-only against every normal role, not against a database owner acting deliberately.

## Proof (rolled back): supabase/tests/gh2995_accept_cpa_proof.sql
One BEGIN ... ROLLBACK. Throwaway run (PostgreSQL 16, hand-written minimal schema `supabase/tests/gh2995_throwaway_schema.sql`, runner `gh2995_accept_cpa_proof_run.sh`): phases TODAY (controls L1/L2 show the defect: the legacy path keeps the first IP only under `cpa_reaccept` and the next call overwrites it), AFTER (40 rows, 0 failing), ROLLBACK (equals TODAY), REAPPLIED (40 rows, 0 failing). Production run (is_test rows only) is NOT done by this PR: splice the forward file inside the proof's transaction and run it once with a human-approved window; expected `FAILING=0 of 40`.

## Apply (not done by this PR)
1. R-097 notice window closes; PR approved with REVIEW + LEGAL-READ + R-177.
2. Apply the forward SQL (no BEGIN/COMMIT in it) through the Tier 3B path; record the ledger version; file it under `supabase/migrations/<version>_gh2995_accept_cpa_append_only.sql`; move the draft per `supabase/migrations_drafts/README.md`.
3. Merge/deploy the page change only after step 2.
4. Verify (closes-on, is_test contractor only): re-accept through the page twice, then `SELECT id, kind, accepted_at, accepted_ip, accepted_ua, agreement_version FROM public.contractor_cpa_acceptances WHERE contractor_id = '<is_test id>' ORDER BY accepted_at` shows two distinct rows, `v1-2026-04`, and the first row's IP unchanged.

## Rollback
`supabase/migrations_rollbacks/gh2995_accept_cpa_append_only_rollback.sql`. It DROPS the records: export them first. Revert the page change first.
