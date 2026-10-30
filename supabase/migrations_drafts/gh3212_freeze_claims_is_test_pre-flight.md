<!--
STATUS (gh-1438, as of 2026-10-30T12:50:00Z): NOT APPLIED -- DRAFT
REPO COPY: none
FILE ROLE: pre-flight file of set gh3212_freeze_claims_is_test
EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa); nothing was written.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3212_freeze_claims_is_test

**Issue**: #3212. **Tier**: 3B (security, new trigger on `claims`; R-097 24-hour notice, CTO applies). **Status**: DRAFT, not applied.

## Change summary
Adds `public.claims_freeze_is_test()` (SECURITY INVOKER, `search_path = public, pg_temp`) and trigger `claims_freeze_is_test` (BEFORE UPDATE OF is_test, FOR EACH ROW). From `anon` / `authenticated` (and not `auth.role() = 'service_role'`) a change of `is_test` raises 42501 `claims.is_test can only be changed by service_role (gh-3212)`. An UPDATE that leaves `is_test` unchanged passes. No column privilege is revoked, no row changes. Rollback drops the trigger and the function.

## Why a separate trigger (composes with PR #3209)
PR #3209 (gh-3197) replaces `claims_guard_referral_columns()` to add an INSERT-only block that raises `is_test` from the owner's profile, and keeps an authenticated INSERT with explicit `is_test = true` working. This change is UPDATE-only and lives in its own function and trigger, so the two migrations touch no common object, apply in either order, and neither rollback undoes the other. The CI test that pins `claims_guard_referral_columns()` (exactly three 42501 refusals, `tests/gh2479-static-born-state-guard.mjs`) is unaffected.

## Measured 2026-10-30 (SELECT only)
| What | Value |
|---|---|
| `has_column_privilege(...,'public.claims','is_test','UPDATE')` anon / authenticated / service_role | true / true / true (INSERT also true for all three) |
| non-internal triggers on `claims` that read or write `is_test` on UPDATE | none writes it. `trg_notify_admin_out_of_state_claim` (WHEN `is_test IS NOT TRUE`), `notify_admin_new_claim` and `notify_ga4_mp_conversion` (INSERT) only read it |
| `claims_guard_referral_columns()` on UPDATE | freezes `referral_id`, `completion_date`, `created_at`, `status` only; not `is_test` |
| public functions with an `UPDATE claims ... is_test` statement | none |
| claims | 38 total, 31 `is_test`, 7 not |

## Legitimate writers of claims.is_test (repo grep at origin/main c8142228 + prod function scan)
- Browser: `trade-selector.html:1486` and `react-app/app/trade-selector/page.tsx:1033` set `is_test` on the claim **INSERT** only (not an UPSERT; no `onConflict`). Untouched by this migration (INSERT behaviour belongs to #3209).
- No client `.update()` on `claims` names `is_test`; the other claims updates (help-measurements, project-info-*, dashboard, repair-intake, bids) do not send it.
- Edge Functions only read `claims.is_test`; none writes it. service_role would be unaffected anyway.
- `admin-*.html` pages only display `is_test` (chips / filters); none updates it.
- Backfills and test seeds run as service_role / postgres (for example the gh3197 backfill draft), which this trigger does not touch.
Result: no legitimate client writer found; nothing to break.

## Proof plan (run by the CTO; BEFORE now, AFTER once applied)
```sql
-- P1 defect now: column privilege (true = defect surface; stays true after, the trigger is the control)
SELECT has_column_privilege('authenticated','public.claims','is_test','UPDATE') AS auth_upd, has_column_privilege('anon','public.claims','is_test','UPDATE') AS anon_upd;
-- P2 trigger inventory. BEFORE: no row. AFTER: one row, BEFORE UPDATE OF is_test
SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname='claims_freeze_is_test';
-- P3 function body. BEFORE: absent. AFTER: contains 'gh-3212' and ERRCODE '42501'
SELECT pg_get_functiondef('public.claims_freeze_is_test()'::regprocedure);
-- P4 execute surface: the function is a trigger function; confirm nobody gains anything new
SELECT has_function_privilege('authenticated','public.claims_freeze_is_test()','EXECUTE') AS auth_exec;
-- P5 no existing row changes: count must be identical BEFORE and AFTER (38 / 31 / 7 on 2026-10-30, drifts only with real sign-ups)
SELECT count(*), count(*) FILTER (WHERE is_test IS TRUE), count(*) FILTER (WHERE is_test IS NOT TRUE) FROM public.claims;
```

### Behavioural proof (one batch, forced rollback)
`supabase/tests/gh3212_freeze_claims_is_test_proof.sql`, same method as `supabase/tests/gh2997_inherit_is_test_proof.sql`: results accumulate in one text variable returned in the final `RAISE EXCEPTION` message, so they survive the rollback. BEFORE the fix run the file alone; AFTER run the migration body (BEGIN/COMMIT removed) then the file in the same batch. Two throwaway `auth.users`; the claim is inserted as the batch owner with `is_test = true` so no admin alert or GA4 call fires.

| step | BEFORE (defect) | AFTER |
|---|---|---|
| B1 service_role true to false (negative control) | rows=1, false | rows=1, false |
| A2 owner (authenticated, own JWT) false to true | rows=1, true | REFUSED 42501 `claims.is_test can only be changed by service_role (gh-3212)` |
| A1 owner true to false | rows=1, false | REFUSED 42501 |
| A3 anon | 0 rows or refused | 0 rows or refused |
| N1 owner sets is_test to its current value | rows=1 | rows=1 |
| N2 owner updates another column (`property_city`) | rows=1 | rows=1 |
| C1 other signed-in user | rows=0 | rows=0 |
| B2 postgres true to false | false | false |
| P2 trigger present | absent | claims_freeze_is_test |

Closes-on mapping (#3212): "refused (pasted error)" = A1/A2 AFTER; "same update as service_role still succeeds (negative control)" = B1; `has_column_privilege` before and after = P1 (true both times by design).

## Behaviour notes for the CTO
- Refuse, not pin: the issue's closes-on asks for a refusal, and profiles.is_test (gh-2785) also raises. A silent pin (`NEW.is_test := OLD.is_test`) is the one-line alternative if a client is ever found that sends a changed `is_test` and must not error.
- No admin exemption (unlike the award / platform-fee guards): profiles.is_test has none and no admin page writes `claims.is_test`. An admin who must flip a flag does it as service_role / postgres.
- `SET LOCAL lock_timeout = '5s'` in the forward and rollback: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `claims`.
- Apply order versus #3209 and the gh3197 backfill: independent. The backfill runs as service_role / postgres and is not affected by this trigger.

## Rollback
`supabase/migrations_drafts/gh3212_freeze_claims_is_test_rollback.sql` drops the trigger and the function. Changes no row.
