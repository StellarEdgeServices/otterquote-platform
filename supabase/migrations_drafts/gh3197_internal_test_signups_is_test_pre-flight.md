<!--
STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
FILE ROLE: pre-flight file of set gh3197_internal_test_signups_is_test
EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa); nothing was written.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3197_internal_test_signups_is_test

**Issue**: #3197. **Tier**: 3B (function replacement; R-097 24-hour notice, CTO applies). **Status**: DRAFT, not applied.

## Change summary
1. `set_is_test_for_internal_test_domain()` now uses `is_internal_test_email(NEW.email)` (was a single hard-coded `%@otterquote-internal.test`).
2. `claims_guard_referral_columns()` (the one claims guard trigger) gets an INSERT-only block copying `profiles.is_test` (id = `NEW.user_id`) onto the claim. All earlier rules kept verbatim; no new trigger, function or RAISE. Raise-only (never lowers a true).

No backfill is in the file. Rollback restores both bodies exactly; it drops nothing.

## Measured 2026-10-30 (SELECT only)
| What | Value |
|---|---|
| profiles with internal-test email and is_test<>true | 38 (gmail 18, stellaredgeservices 13, otterquote 4, stohlerroof 2, tryotterquote 1) |
| claims owned by those profiles with is_test<>true | 3 |
| claims on is_test profiles with is_test<>true | 0 |
| non-internal profiles is_test<>true / is_test=true | 10 / 1 |

## Proof plan (run by the CTO; BEFORE now, AFTER once applied)
```sql
-- P1 defect, profiles: BEFORE >0 (38), AFTER 0 for rows created after apply (old rows only change if backfilled)
SELECT count(*) FROM profiles WHERE public.is_internal_test_email(email) AND is_test IS NOT TRUE;
-- P2 defect, claims: same idea
SELECT count(*) FROM claims c JOIN profiles p ON p.id = c.user_id WHERE p.is_test AND c.is_test IS NOT TRUE;
-- P3 function body: AFTER must contain is_internal_test_email and not the like-literal
SELECT pg_get_functiondef('public.set_is_test_for_internal_test_domain()'::regprocedure);
-- P4 guard body: AFTER must contain 'gh-3197' and still have exactly 3 ERRCODE '42501'
SELECT pg_get_functiondef('public.claims_guard_referral_columns()'::regprocedure);
-- P5 trigger inventory: AFTER unchanged (no new claims trigger)
SELECT tgname FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND NOT tgisinternal ORDER BY 1;
```
Behavioural proof (one batch, forced ROLLBACK via a final RAISE EXCEPTION, as in supabase/tests/gh2997_inherit_is_test_proof.sql):
1. INSERT a profile `proof+x@otterquote.com` (role service_role) -> `is_test` must be true (BEFORE: false).
2. INSERT a claim for that user_id with is_test left default -> `claims.is_test` must be true (BEFORE: false).
3. **Negative control**: INSERT a profile `proof+x@example.com` and a claim for it -> both `is_test` stay false (BEFORE and AFTER).
4. Never-lower control: INSERT a claim with explicit `is_test=true` for the non-internal profile -> stays true.

## Open question for the CTO / Ben
Backfill: the issue says "Backfill SELECT ... first" but does not say whether to UPDATE the 38 profiles and 3 claims. The migration does not (spec scope = function + guard). If wanted, a follow-up UPDATE scoped to `is_internal_test_email(email)` profiles and their claims is the obvious shape; note profiles_freeze_privileged_columns blocks `is_test` changes for client roles, so it must run as service_role/postgres.
