<!--
STATUS (gh-1438, as of 2026-11-05T20:30:30Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3460_held_fee_release (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-05 under #3460 from the repo only. No production query was run to write it; the queries below are for the CTO to run read-only before the apply.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3460_held_fee_release

Issue #3460 (P18), parent #3447, owed by PR #3455. Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.

## What it changes
1. New trigger `partner_fee_accrue_on_role_settled` on `hover_orders`: `AFTER UPDATE OF requested_by_role ... WHEN (OLD = 'unspecified' AND NEW = 'homeowner')`, running the existing `partner_fee_accrue_on_order()` (not modified, not copied).
2. New function `admin_settle_order_buyer_role(uuid, text, uuid, text, boolean)`: admin or service role only (`is_admin_email()` / `service_role`, the check `create_monthly_fee_batch` uses). Not executable by anon.
No table, column, setting or existing function is altered. No data is written at apply time.

## Hard prerequisites (the forward file refuses, SQLSTATE 55000, and changes nothing, if either is missing)
- `gh3229_partner_measurement_fee.sql` applied (`partner_fee_accrue_on_order()`, `partner_fee_events`), which itself needs `gh3239_partner_agreement_v4.sql`.
- `is_admin_email()`.
PR #3455 (Edge Function change that creates `unspecified` orders) does not have to be applied first: with no `unspecified` rows the trigger and function do nothing.

## Read-only checks before the apply
```sql
-- 1. the accrual function is the gh3229 body and the insert trigger exists
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.hover_orders'::regclass AND NOT tgisinternal;
SELECT pg_get_functiondef('public.partner_fee_accrue_on_order()'::regprocedure) ILIKE '%partner_v4_accepted_at%' AS has_v4_gate;
-- 2. nobody but an admin can UPDATE hover_orders (the new arm must not become a client-reachable accrual path); want: only hover_orders_admin_all for UPDATE, no UPDATE grant to anon
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'public.hover_orders'::regclass;
SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='hover_orders' AND privilege_type IN ('UPDATE','INSERT');
-- 3. how many held orders exist today (informational)
SELECT id, claim_id, created_at, homeowner_stripe_payment_intent_id FROM public.hover_orders WHERE requested_by_role = 'unspecified' ORDER BY created_at;
-- 4. names free
SELECT 1 FROM pg_trigger WHERE tgname = 'partner_fee_accrue_on_role_settled';
SELECT 1 FROM pg_proc WHERE proname = 'admin_settle_order_buyer_role';
```
Check 2 matters: if a non-admin role can UPDATE `hover_orders.requested_by_role`, add a column guard before applying (the insert path has the same trust today, but this arm adds a second way to reach accrual).

## Apply notes
- Lock: `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on `hover_orders` (small table, seconds); `lock_timeout` is 5s.
- No Edge Function or page needs to deploy first. `admin-measurements.html` in the same PR changes only when the ready email is re-sent.

## Verify
Run `supabase/tests/gh3460_held_fee_release_proof.sql` (single rolled-back batch). Local: `supabase/tests/gh3460_held_fee_release_local_run.sh before|after|rollback|mutant-*`.
After the apply, in the SQL editor as an admin session: `SELECT admin_settle_order_buyer_role('<held order id>', 'homeowner', NULL, '<why>')`. See `runbooks/held-partner-fee-release.md`.

## Rollback
`gh3460_held_fee_release_rollback.sql`. Drops the trigger and function only; accrued fee rows and settled roles stay.
