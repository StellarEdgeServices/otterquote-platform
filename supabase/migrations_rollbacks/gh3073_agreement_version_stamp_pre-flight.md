# gh-3073 pre-flight: server-held agreement_version stamped inside accept_cpa()

Tier 3B, contractor-agreement path (D-366), CREATE OR REPLACE of a SECURITY DEFINER function. NOT APPLIED. Needs: tier:3b applied by the CTO, R-177 pair, migration-author review, R-097 24-hour notice, then a recorded apply. Depends on the gh-2995 forward file (accept_cpa(), contractor_cpa_acceptances) being applied FIRST. No page or Edge Function change is needed: every caller (contractor-pre-approval.html, contractor-dashboard.html, react-app pre-approval `utils.ts`, dashboard `cpa-evidence.ts`) calls `rpc('accept_cpa', { p_version })` and only reads `acceptance_id`; the signature and return shape are unchanged.

## What changes
1. New single-row table `public.agreement_version_current` (`singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`, `version_label text NOT NULL` with CHECK `^v[0-9]+-[0-9]{4}-[0-9]{2}$`, `set_at`). Seeded with `v2-2026-10`. It is separate from `public.cpa_versions` (D-366: CPA version and agreement version stay distinct values). RLS enabled, no policies, `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`: no client role can read or write it; only the owner and SECURITY DEFINER code. A future version bump is a Tier 3B one-row UPDATE.
2. `public.accept_cpa(p_version text)` redefined (same signature, return value, activity_log strings, SECURITY DEFINER, `search_path = public, pg_temp`). Added: read the single row into `v_agr` (SQLSTATE 55000 `agreement_version_unset` if the row is missing, so nothing is written with a NULL stamp) and set `contractors.agreement_version` from it. First acceptance: always set. Re-acceptance: only a NULL is filled; an existing value is never moved. The value is never taken from a parameter. EXECUTE grants restated exactly as gh-2995 left them (`REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated`).
3. `contractors_freeze_privileged_columns()` is NOT touched. Direct client INSERT of `agreement_version` is forced to NULL and a direct client UPDATE is pinned to OLD (set by gh-2995); accept_cpa() passes the existing `current_user <> 'authenticated'` exemption.

## Read-only checks the applier runs first (production, SELECT only)
```sql
-- 1. gh-2995 is applied (both columns must be true):
SELECT to_regprocedure('public.accept_cpa(text)') IS NOT NULL AS has_accept_cpa, to_regclass('public.contractor_cpa_acceptances') IS NOT NULL AS has_table;
-- 2. the new source does not exist yet (must be false):
SELECT to_regclass('public.agreement_version_current') IS NOT NULL AS source_already_there;
-- 3. the live accept_cpa body still equals the gh-2995 base (compare byte for byte with the function in supabase/migrations_drafts/gh2995_accept_cpa_append_only.sql):
SELECT md5(pg_get_functiondef('public.accept_cpa(text)'::regprocedure)), pg_get_functiondef('public.accept_cpa(text)'::regprocedure);
-- 4. grants as gh-2995 left them (record the proacl; the forward file restates the same grants):
SELECT proacl::text, prosecdef, proconfig::text FROM pg_proc WHERE oid = 'public.accept_cpa(text)'::regprocedure;
-- 5. the current CPA version is unchanged and is a different value from the agreement version:
SELECT version_label, is_current FROM public.cpa_versions WHERE is_current;
-- 6. what agreement_version holds today (v2-2026-10 expected on pre-#2995 contractors, NULL on any onboarded since #2995):
SELECT agreement_version, count(*) AS n, count(*) FILTER (WHERE is_test) AS n_test FROM public.contractors GROUP BY 1 ORDER BY 2 DESC;
-- 7. the freeze trigger still pins the column (must be true):
SELECT pg_get_functiondef('public.contractors_freeze_privileged_columns()'::regprocedure) ILIKE '%NEW.agreement_version%OLD.agreement_version%' AS pins_update;
```
Stop and report if check 1 returns false, check 2 returns true, or check 3 differs from the base.

## Value check (D-366)
The seed `v2-2026-10` is the value the repo already writes today (react-app `pre-approval/utils.ts` `AGREEMENT_VERSION = 'v2-2026-10'`, asserted by `pre-approval.test.ts`; the proof and issue #3073 use the same value). The memory registry entry for D-366 does not itself spell the label. R-177 reviewers: confirm the label with the CTO/CEO before apply.

## Behaviour changes the reviewers should see
- A contractor onboarded through pre-approval after this applies ends with `agreement_version = 'v2-2026-10'` (server-stamped), `cpa_version` unchanged (`v1-2026-04`).
- Contractors onboarded between the gh-2995 apply and this apply have `agreement_version` NULL. This migration does not backfill them (all contractors are `is_test` today). Their next `accept_cpa()` call (a re-acceptance) fills the NULL. If a backfill is wanted it is a separate, named decision.
- The activity_log metadata key `agreement_version` and the function's return key `agreement_version` still carry the CPA version (gh-2995 naming, left unchanged to keep this change narrow).

## Proof (rolled back): supabase/tests/gh3073_agreement_version_proof.sql
Runner `gh3073_agreement_version_proof_run.sh` on a throwaway Postgres: 1-BASELINE (gh-2995 function: the negative control, `agreement_version` stays NULL after a pre-approval onboarding) -> 2-AFTER (forward applied: stamped with the server's value, direct client UPDATE refused, cpa_version unchanged) -> 3-ROLLBACK (equals BASELINE) -> 4-REAPPLIED. STATUS: authored, NOT RUN (no local Postgres on the authoring machine). The first real run must happen on a throwaway Postgres 16 and be attached to the PR before review.

## Apply (not done by this PR)
1. tier:3b applied, R-097 notice window closes, R-177 pair on the PR.
2. Run the pre-flight SELECTs above.
3. Apply the forward SQL (no BEGIN/COMMIT in it) through the Tier 3B path; record the ledger version; file under `supabase/migrations/<version>_gh3073_agreement_version_stamp.sql`; move the draft per `supabase/migrations_drafts/README.md`.
4. Verify on an is_test contractor: `SELECT agreement_version, cpa_version FROM public.contractors WHERE id = '<is_test id>'` after a pre-approval run shows `v2-2026-10` / `v1-2026-04`.

## Rollback
`supabase/migrations_rollbacks/gh3073_agreement_version_stamp_rollback.sql` (restores the gh-2995 accept_cpa() body exactly, drops the source table). Stamped values remain.
