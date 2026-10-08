# gh-2310 Gap 3 pre-flight: referrals backfill (9 rows) + admin_list_referrals is_test predicate

Tier 3B. NOT APPLIED. Ruling: #2310 comment 6046227412. R-097 24-hour notice on #2310 first; this PR is a draft and nothing here has run against production.

## What changes
1. `gh2310_gap3_backfill_referrals_is_test.sql`: `UPDATE public.referrals SET is_test = true` for nine exact ids, only where the row is `is_test=false` and its `referral_agents` row is `is_test=true`. Guarded: the DO block raises unless exactly nine rows change. The only trigger on `referrals` (`referrals_update_stats`, AFTER UPDATE) acts on a status change; status does not change.
2. `gh2310_gap3_admin_list_referrals_is_test.sql`: `admin_list_referrals()` gains `AND r.is_test IS NOT TRUE AND ra.is_test IS NOT TRUE`. Same signature, grants, gate, order and limit. Unattributed rows stay listed.

## Print the nine rows before applying (SELECT only)
```sql
select r.id, r.referral_agent_id, a.is_test as agent_is_test, r.is_test as ref_is_test, r.created_at
from referrals r join referral_agents a on a.id = r.referral_agent_id
where r.is_test = false and a.is_test = true
order by r.created_at, r.id;
```
Expected, measured 2026-10-07T20:28Z (project yeszghaspzwwstvsrioa), exactly these nine:
```
97253d12-6691-4308-8bf0-754b29b5ece7  76c64636-81c0-4ac0-ac36-c061b1a945b1  2026-08-05 12:30:13
596b5ec3-b381-4261-b10d-ba438b401c8b  76c64636-81c0-4ac0-ac36-c061b1a945b1  2026-08-05 12:50:46
6ede692b-a7c0-43b1-b0cb-f318fb209c32  76c64636-81c0-4ac0-ac36-c061b1a945b1  2026-08-05 12:51:12
3c62b0f1-4b40-44c2-a394-ca77ebfdce69  76c64636-81c0-4ac0-ac36-c061b1a945b1  2026-08-05 12:51:35
a240bb83-2e38-4d64-aa76-44d675556b43  1927861f-8836-49ce-a528-08c432cc69cc  2026-08-17 23:59:57
d843c6d4-35ba-46c4-adfa-a5909e267065  1927861f-8836-49ce-a528-08c432cc69cc  2026-08-18 19:39:48
a034c167-8140-4a0f-af63-0acd84be338d  0a934e11-5cac-4607-a63c-7446fe446f81  2026-08-18 21:39:48
b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5  1927861f-8836-49ce-a528-08c432cc69cc  2026-08-27 19:59:06
82d58235-2c70-423a-b682-afedd3d745c9  1927861f-8836-49ce-a528-08c432cc69cc  2026-08-27 19:59:07
```
If the SELECT returns anything other than these nine ids, stop: the data moved since the notice.

Also record: `select md5(pg_get_functiondef('public.admin_list_referrals()'::regprocedure))` must be `9da71c08…` (the rollback restores exactly this body).

## Business effect
Nine click rows made by our own staff accounts in August stop counting as real referral clicks (the Business Lines dashboard referral-clicks series reads `referrals.is_test`). The admin Referrals table stops listing rows under test or staff agents (48 listed today, 10 after; measured read-only). Nothing a partner or homeowner sees changes. No email is sent.

## Apply (not done by this PR)
Notice window closes, PR merged after review, backfill applied through the Tier 3B path, then the function; file both under `supabase/migrations/<ledger version>_...` and update the README row. Verify: the SELECT above returns 0 rows (it returned 9 before: that is the negative control); the function md5 differs from `9da71c08...`; the proof file's final table has 0 failing rows when run (rolled back) beforehand.

## Rollback
`gh2310_gap3_backfill_referrals_is_test_rollback.sql` (exact ids back to false) and `gh2310_gap3_admin_list_referrals_is_test_rollback.sql` (md5 returns to `9da71c08...`).
