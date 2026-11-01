<!--
STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3219_partner_credit_lock (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3219; production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): referrals has no homeowner_user_id; referral_attribution_window() is IMMUTABLE `SELECT interval '30 days'`; platform_settings has no partner_attribution_window_days key. The set is a new draft, nothing applied.
REPO COPY: none. When the set is applied, move this pre-flight to supabase/migrations_rollbacks/ under the forward file's ledger version.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3219_partner_credit_lock

**Migration**: `gh3219_partner_credit_lock.sql` (DRAFT, this directory) / rollback `gh3219_partner_credit_lock_rollback.sql`
**Implements**: D-402 (registered 2026-10-30; supersedes D-349, the 30-day window; Dustin 2026-10-30).
**Issue**: #3219 (PROJECT P18). **Tier**: 3B (R-097): changes how partner money is credited. Needs REVIEW + LEGAL-READ + R-177 pair; the CTO applies after the R-097 notice. Nothing here has been applied; production was only read (SELECTs).

## Change summary
One plan for every partner: 90-day window from the click, last click wins, credit LOCKS at account creation. STRICT: credit is decided when the account is created; a click made after the account exists does not attach a lock or a credit (unless the account's own lock has lapsed, Ben's lapse ruling). An account created with no in-window partner click stays unattributed.
- `referrals.homeowner_user_id uuid NULL` (FK auth.users, ON DELETE SET NULL) + unique partial index `referrals_homeowner_user_id_locked_key`.
- `referral_attribution_window()` now reads `platform_settings.partner_attribution_window_days` (seed 90; fallback 90 when absent, non-numeric, <1 or >3650) and is STABLE (was IMMUTABLE 30 days).
- `advance_referral_registered(uuid)` records the signed-in user on the referral it advances; a user who already has a LIVE locked referral gets `false`. A lapsed lock (its click older than the window) blocks nobody and is released when a newer in-window click takes the lock.
- The forward file REFUSES to run (RAISE) while anon or authenticated hold table-level SELECT on `public.referrals`, i.e. before PR #3225 part B (`gh3217b_referrals_column_allowlist`).
- `get_locked_referral_id()` (new, authenticated + service_role) returns the caller's LIVE locked referral id (NULL once the lock has lapsed).
- `claims_apply_locked_referral()` + trigger `claims_lock_referral` (new, BEFORE INSERT on claims): a live locked referral_id and its referral_agent_id replace whatever the browser sent. LAPSE (Ben's ruling, #3219 comment 6523708028): once the locked click is older than the window the lock is ignored; a newer in-window click on the claim is credited and takes the lock (the lapsed referral's `homeowner_user_id` is cleared), otherwise the claim's `referral_id` is set NULL and nobody is credited.
- `claims_advance_referral()` advances only the user's own live locked referral, or an unlocked one (which it then locks to the claim's user, releasing a lapsed lock of that user).
- NOT edited but affected: `apply_referral_commission()` calls `referral_attribution_window()`, so its "referral not older than the window at claim time" check moves from 30 to 90 days with the setting.

## Read-only checks to run before apply (all SELECT)
1. `select oid::regprocedure, provolatile, md5(prosrc) from pg_proc where proname in ('referral_attribution_window','advance_referral_registered','claims_advance_referral') and pronamespace='public'::regnamespace;` expect `i`/`12f25d9ee84d4a58211e08e5c92f4c74` (advance) / `99cb315ff314f88fd33ea5b5e5d61d13` (claims_advance) / `4b45984d8648af2b7027987969c6135f` (window). If any differs, the rollback no longer restores "exactly": re-read and regenerate it first.
2. `select column_name from information_schema.columns where table_name='referrals' and column_name='homeowner_user_id';` expect no row.
3. `select * from platform_settings where key='partner_attribution_window_days';` expect no row.
4. `select tgname from pg_trigger where tgrelid='public.claims'::regclass and tgname='claims_lock_referral';` expect no row.
5. Existing locks to carry over (none are written by this file): `select count(distinct user_id) from claims where referral_id is not null;` read 1 on 2026-10-30; users with two different referral_ids: 0.

## Order of operations (the forward file enforces the first step)
1. Apply #3225 part B first (`gh3217b_referrals_column_allowlist`). Dustin gave GO on #3225 on 2026-10-30. Until it is applied this file raises `gh3219: anon/authenticated still hold table-level SELECT on public.referrals ...` and changes nothing.
2. Then apply this set.
3. Do NOT run #3225's rollback while this set is applied (it re-grants table-level SELECT and would make `homeowner_user_id` partner-readable): run `gh3219_partner_credit_lock_rollback.sql` first.

## Effects to know before approving
- No backfill. Users who already have a claim with a referral_id are NOT locked until their next advance or claim; a backfill from `claims (user_id, referral_id)` is a separate decision.
- Referral clicks 31-90 days old that were refused under the 30-day rule become creditable again, in `advance_referral_registered`, `claims_advance_referral` and `apply_referral_commission`.
- **Lowering `partner_attribution_window_days` also cancels, at completion, the referral fee (and any later per-order fee, e.g. #3236's measurement fee) on claims already credited under the longer window**, because `apply_referral_commission()` re-tests click-to-claim against the CURRENT setting. Example: click day 0, claim day 80, credited and emailed; the setting is lowered to 60; the fee never accrues. Changing this setting is a Dustin decision (Tier C, money), not an ops toggle. The same sentence is in the COMMENT on `referral_attribution_window()`.
- Changing `partner_attribution_window_days` later changes all three at once and applies to clicks already on record. The browser cookie lifetime is a fixed 90 days in code; a setting above 90 is not reachable by a cookie that has expired, a setting below 90 is enforced by the database.
- `homeowner_user_id` must NOT be partner-readable (Ben, #3219). Live today `authenticated` holds a table-level SELECT on `referrals`, so until PR #3225 (#3217) is applied a partner could read the new column through the "Agents can read own referrals" policy. #3225 revokes the table-level SELECT and re-grants an explicit allow-list (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount) that excludes it; this migration adds no GRANT/REVOKE on `referrals`. Order: apply #3225 first (then the new column is private by default), or apply both in the same window; whichever merges second must keep `homeowner_user_id` off the allow-list. Rolling back #3225 restores the table-level SELECT and would expose the column again. `tests/p18-homeowner-user-id-not-granted.mjs` fails if any referrals GRANT in the repo names it.
- Lapse is decided at claim time against `now()` and the CURRENT window setting: shortening `partner_attribution_window_days` lapses locks earlier, lengthening it revives locks whose click is still inside the new window.
- **Claim gate** (REVIEW: FAIL 6524490927 finding 4): after the BEFORE INSERT trigger, `claims.referral_id` is NULL or a referral credited to that claim's user. A sent referral locked to another user (shared browser), outside the window, past `registered` and not this user's own, or clicked after the user's account was created is cleared, so no fee can accrue on a referral not credited to the claim's user. The `EXISTS claims` arm keeps the one existing user with an un-backfilled referral working.
- **Strict lock changes behaviour for returning homeowners**: today any sign-in with a partner cookie advances the referral, including for an account created long before the click; under this file that click is not credited and not locked. An account created with no in-window partner click stays unattributed. (Confirmed by Ben, 2026-10-30.)
- A lapsed lock with no newer click leaves the lapsed referral's `homeowner_user_id` set (it is only cleared when a newer referral takes the lock).
- Lock timeout: the file sets `lock_timeout = '5s'`; `ALTER TABLE referrals ADD COLUMN` (nullable, no default) is a catalogue-only change. Apply off-peak (R-031).

## Proof
`supabase/tests/gh3219_partner_credit_lock_proof.sql`: one batch, last statement a forced RAISE EXCEPTION that prints every case; claims are rows of a TEMP table carrying the REAL trigger functions; fixtures are `is_test` users and agents; the only DDL inside it is rolled back. BEFORE: run alone (cases marked [BUG] differ). AFTER: the forward body (BEGIN/COMMIT removed) at the `@@MIGRATION@@` marker. Local throwaway-Postgres run: `bash supabase/tests/gh3219_partner_credit_lock_local_run.sh before|after|rollback|mutant-nolock`.

## Rollback
`gh3219_partner_credit_lock_rollback.sql` restores the three functions to the live bodies listed above (md5 compared in the local `rollback` run), drops the trigger, the two new functions, the index, the column and the setting. Dropping the column deletes recorded locks: export `(id, homeowner_user_id)` first if any exist.
