<!--
STATUS (gh-1438, as of 2026-10-30T12:30:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3217_mask_referral_homeowner (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3217; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3217_mask_referral_homeowner

Issue #3217 (P18). R-134 protective-only (removes partner access to homeowner contact data). Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies.

## What it changes
1. Adds `public.get_my_referrals()` (SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE to authenticated and service_role only). Returns id, status, created_at, display_name (first name + last initial), job_value, commission_amount, commission_paid_at, recruit_commission_amount, recruit_paid_at, is_test, referral_agent_id. No email, phone, address or city.
2. Revokes table-level SELECT on `public.referrals` from `anon` and `authenticated`; re-grants column SELECT to `authenticated` on id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount only. homeowner_name, homeowner_email, homeowner_phone and metadata are no longer readable by client roles.

## Deploy order (important)
The old dashboards run `select('*')` on referrals; once the migration lands that query fails with permission denied. The new dashboards (this PR) call `get_my_referrals()`, which does not exist until the migration lands. There is no ordering with zero gap, so: apply the migration, then let the Netlify deploy of this PR finish immediately after (or merge first and apply as soon as the deploy is live; a partner dashboard that cannot load the referral list for a few minutes is the failure mode, no data is exposed or lost). Smoke-test /partner-dashboard.html and /refer-a-friend.html straight after. Today there are 2 non-test partners.

## Live state read (2026-10-30, read-only)
- Policies on referrals: "Agents can read own referrals" (SELECT, public, EXISTS referral_agents.user_id = auth.uid()); "Service role full access" (ALL). Left unchanged.
- relacl: anon and authenticated hold rwdDxtm table-level; no pg_attribute.attacl entries.
- No view or other table's policy references `referrals`; no non-SECURITY-DEFINER function reads it. Trigger `referrals_update_stats` (AFTER UPDATE) is unaffected.
- Edge-function readers all use the service-role client. `admin-referrals.html` uses `admin_list_referrals()` (SECURITY DEFINER).

## Verify
Run `supabase/tests/gh3217_mask_referral_homeowner_proof.sql` (single rolled-back batch; the result is in the final exception message). Spot check as a partner: `select homeowner_email from referrals` -> permission denied; `select * from get_my_referrals()` -> own rows, masked names.

## Rollback
`gh3217_mask_referral_homeowner_rollback.sql` restores table-level SELECT for anon and authenticated and drops the function. It re-opens the breach.
