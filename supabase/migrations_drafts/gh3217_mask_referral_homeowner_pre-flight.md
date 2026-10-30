<!--
STATUS (gh-1438, as of 2026-10-30T12:30:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3217_mask_referral_homeowner (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3217; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3217_mask_referral_homeowner

Issue #3217 (P18). R-134 protective-only (removes partner access to homeowner contact data). Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies.

## What it changes (two draft files)
**Part A, `gh3217a_get_my_referrals.sql` (additive).** Adds `public.get_my_referrals()` (SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE to authenticated and service_role only; PUBLIC and anon revoked). Returns id, status, created_at, display_name (first name + last initial), job_value, commission_amount, commission_paid_at, recruit_commission_amount, recruit_paid_at, is_test, referral_agent_id. No email, phone, address or city. Removes nothing; the live pages keep working.

**Part B, `gh3217b_referrals_column_allowlist.sql` (the lockdown).** Revokes table-level SELECT on `public.referrals` from `anon` and `authenticated`; re-grants column SELECT to `authenticated` on id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount only. homeowner_name, homeowner_email, homeowner_phone and metadata are no longer readable by client roles.

## Apply order (zero outage)
1. Apply Part A. Nothing is removed, so the old dashboards keep working.
2. Merge and deploy the frontend of PR #3225 (it calls `get_my_referrals()`, which now exists).
3. Smoke-test as a partner: /partner-dashboard.html, /refer-a-friend.html, React /partner/dashboard, React /refer. Each must list referrals with masked names and no console error.
4. Apply Part B. Re-run the smoke test and the proof.

Do not apply B before step 3 passes: until the frontend is live the old `select('*')` calls would fail with permission denied.

## Live state read (2026-10-30, read-only)
- Policies on referrals: "Agents can read own referrals" (SELECT, public, EXISTS referral_agents.user_id = auth.uid()); "Service role full access" (ALL). Left unchanged.
- relacl: anon and authenticated hold rwdDxtm table-level; no pg_attribute.attacl entries.
- No view or other table's policy references `referrals`; no non-SECURITY-DEFINER function reads it. Trigger `referrals_update_stats` (AFTER UPDATE) is unaffected.
- Edge-function readers all use the service-role client. `admin-referrals.html` uses `admin_list_referrals()` (SECURITY DEFINER).

## Verify
Run `supabase/tests/gh3217_mask_referral_homeowner_proof.sql` (single rolled-back batch; the result is in the final exception message). Spot check as a partner: `select homeowner_email from referrals` -> permission denied; `select * from get_my_referrals()` -> own rows, masked names.

## Rollback (one file per part)
- `gh3217b_referrals_column_allowlist_rollback.sql`: restores table-level SELECT for anon and authenticated exactly as read live (relacl authenticated=rwdDxtm, anon=rwdDxtm, no column ACLs) and KEEPS the function, so the deployed frontend keeps working. It re-opens the breach.
- `gh3217a_get_my_referrals_rollback.sql`: drops the function. Use only BEFORE the frontend deploys (or after it is reverted); otherwise the live pages lose their referral lists. Roll B back first if B is applied.

## Verify
Run `supabase/tests/gh3217_mask_referral_homeowner_proof.sql` in a single rolled-back batch: after A alone (nothing removed: direct reads still work, RPC masked), after A+B (locked), and after B's rollback (restored). Spot check as a partner: `select homeowner_email from referrals` -> permission denied after B; `select * from get_my_referrals()` -> own rows, masked names.
