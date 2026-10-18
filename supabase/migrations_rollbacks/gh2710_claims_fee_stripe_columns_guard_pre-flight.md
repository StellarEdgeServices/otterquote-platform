# Pre-flight: gh2710_claims_fee_stripe_columns_guard (Tier 3B, money path)

NOT APPLIED. Refs #2710. The follow-up owed by R-177 SIGNED condition (4) on PR #2704 (comment 6155920082): the same guard as gh2491_claims_platform_fee_charged_guard on `claims.platform_fee_amount` and `claims.platform_fee_stripe_id`. Protective only (R-134). R-097 notice applies before apply. R177-NEEDED.

## What it does
Adds `public.claims_guard_fee_stripe_columns()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger `claims_guard_fee_stripe_columns` (`BEFORE INSERT OR UPDATE OF platform_fee_stripe_id, platform_fee_amount ON public.claims`). For client callers (`anon`/`authenticated`, JWT role not `service_role`, not an admin email) it refuses with SQLSTATE 42501 an INSERT that sets either column and an UPDATE that changes either. An unchanged value is not a change. `service_role`, admins and owner-level sessions are untouched.

## Who writes the columns today
- `supabase/functions/docusign-webhook` (`updateData.platform_fee_stripe_id`, `updateData.platform_fee_amount`) and `supabase/functions/stripe-webhook/index.ts` (`platform_fee_stripe_id: latestChargeId`): service-role clients (gh-1759, pinned by `fee-charge-writer.test.ts`). Allowed (proof S1/S2).
- `contractor-bid-form.html` and `react-app/app/contractor/bid/[claimId]/utils.ts` carry a `platform_fee_amount` key in the `send-bid-confirmation` request body only; not a claims write.
- Re-run before apply (SELECT only): `select proname from pg_proc where pronamespace='public'::regnamespace and (prosrc ilike '%platform_fee_stripe_id%' or prosrc ilike '%platform_fee_amount%')` and `select tgname from pg_trigger where tgrelid='public.claims'::regclass and not tgisinternal`; the apply must not proceed if a SQL function other than a service-role path writes either column.

## Order
Independent of gh2491 (PR #2704), gh2626 (PR #2737 edits it), gh2519, gh2564: no shared object. Verified on a throwaway Postgres in three orders (see PR body). Apply requires `public.is_admin_email()` and `auth.role()` (both live).

## Rollback
`supabase/migrations_rollbacks/gh2710_claims_fee_stripe_columns_guard_rollback.sql` drops the trigger and function only.

## Proof
`supabase/tests/gh2710_claims_fee_stripe_columns_guard_proof.sql` via `gh2710_claims_fee_stripe_columns_guard_proof_run.sh`.
