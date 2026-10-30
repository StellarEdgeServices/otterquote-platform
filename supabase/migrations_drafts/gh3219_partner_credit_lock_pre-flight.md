<!--
STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3219_partner_credit_lock (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3219; production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): referrals has no homeowner_user_id; referral_attribution_window() is IMMUTABLE `SELECT interval '30 days'`; platform_settings has no partner_attribution_window_days key. The set is a new draft, nothing applied.
REPO COPY: none. When the set is applied, move this pre-flight to supabase/migrations_rollbacks/ under the forward file's ledger version.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3219_partner_credit_lock

**Migration**: `gh3219_partner_credit_lock.sql` (DRAFT, this directory) / rollback `gh3219_partner_credit_lock_rollback.sql`
**Issue**: #3219 (PROJECT P18). **Tier**: 3B (R-097): changes how partner money is credited. Needs REVIEW + LEGAL-READ + R-177 pair; the CTO applies after the R-097 notice. Nothing here has been applied; production was only read (SELECTs).

## Change summary
One plan for every partner: 90-day window from the click, last click wins, credit LOCKS at account creation.
- `referrals.homeowner_user_id uuid NULL` (FK auth.users, ON DELETE SET NULL) + unique partial index `referrals_homeowner_user_id_locked_key`.
- `referral_attribution_window()` now reads `platform_settings.partner_attribution_window_days` (seed 90; fallback 90 when absent, non-numeric, <1 or >3650) and is STABLE (was IMMUTABLE 30 days).
- `advance_referral_registered(uuid)` records the signed-in user on the referral it advances; a user who already has a locked referral gets `false`.
- `get_locked_referral_id()` (new, authenticated + service_role) returns the caller's locked referral id.
- `claims_apply_locked_referral()` + trigger `claims_lock_referral` (new, BEFORE INSERT on claims): the locked referral_id and its referral_agent_id replace whatever the browser sent.
- `claims_advance_referral()` advances only the user's own locked referral, or an unlocked one (which it then locks to the claim's user).
- NOT edited but affected: `apply_referral_commission()` calls `referral_attribution_window()`, so its "referral not older than the window at claim time" check moves from 30 to 90 days with the setting.

## Read-only checks to run before apply (all SELECT)
1. `select oid::regprocedure, provolatile, md5(prosrc) from pg_proc where proname in ('referral_attribution_window','advance_referral_registered','claims_advance_referral') and pronamespace='public'::regnamespace;` expect `i`/`12f25d9ee84d4a58211e08e5c92f4c74` (advance) / `99cb315ff314f88fd33ea5b5e5d61d13` (claims_advance) / `4b45984d8648af2b7027987969c6135f` (window). If any differs, the rollback no longer restores "exactly": re-read and regenerate it first.
2. `select column_name from information_schema.columns where table_name='referrals' and column_name='homeowner_user_id';` expect no row.
3. `select * from platform_settings where key='partner_attribution_window_days';` expect no row.
4. `select tgname from pg_trigger where tgrelid='public.claims'::regclass and tgname='claims_lock_referral';` expect no row.
5. Existing locks to carry over (none are written by this file): `select count(distinct user_id) from claims where referral_id is not null;` read 1 on 2026-10-30; users with two different referral_ids: 0.

## Effects to know before approving
- No backfill. Users who already have a claim with a referral_id are NOT locked until their next advance or claim; a backfill from `claims (user_id, referral_id)` is a separate decision.
- Referral clicks 31-90 days old that were refused under the 30-day rule become creditable again, in `advance_referral_registered`, `claims_advance_referral` and `apply_referral_commission`.
- Changing `partner_attribution_window_days` later changes all three at once and applies to clicks already on record. The browser cookie lifetime is a fixed 90 days in code; a setting above 90 is not reachable by a cookie that has expired, a setting below 90 is enforced by the database.
- `referrals` has table-level SELECT for `authenticated` behind the "Agents can read own referrals" policy, so a partner reading their own referrals can read the new `homeowner_user_id` (an auth user uuid) beside the homeowner name/email/phone they can already read.
- A user whose locked referral is older than the window at claim time gets that referral stamped and not credited (the lock still holds; a fresh click cannot take it). Open question for the CEO, see the PR.
- Lock timeout: the file sets `lock_timeout = '5s'`; `ALTER TABLE referrals ADD COLUMN` (nullable, no default) is a catalogue-only change. Apply off-peak (R-031).

## Proof
`supabase/tests/gh3219_partner_credit_lock_proof.sql`: one batch, last statement a forced RAISE EXCEPTION that prints every case; claims are rows of a TEMP table carrying the REAL trigger functions; fixtures are `is_test` users and agents; the only DDL inside it is rolled back. BEFORE: run alone (cases marked [BUG] differ). AFTER: the forward body (BEGIN/COMMIT removed) at the `@@MIGRATION@@` marker. Local throwaway-Postgres run: `bash supabase/tests/gh3219_partner_credit_lock_local_run.sh before|after|rollback|mutant-nolock`.

## Rollback
`gh3219_partner_credit_lock_rollback.sql` restores the three functions to the live bodies listed above (md5 compared in the local `rollback` run), drops the trigger, the two new functions, the index, the column and the setting. Dropping the column deletes recorded locks: export `(id, homeowner_user_id)` first if any exist.
