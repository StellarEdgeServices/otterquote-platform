<!--
STATUS (gh-1438, as of 2026-10-21): NOT APPLIED
FILE ROLE: pre-flight file of set gh2105_color_contractor_rpc (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-21 under #2105 (CTO RUN 76, checklist item C, comment 6305573044; Dustin's answer on #2974, comment 6323378714). No database was read or written to produce this file; the production facts it relies on (homeowners have no SELECT on public.contractors; contractors.company_name text NOT NULL and contractors.preferred_brands text[] exist; claims.user_id and claims.selected_contractor_id exist) are those recorded in comment 6305573044 and supabase/migrations/20260101000000_v000_baseline_schema.sql, and are to be re-measured in the pre-flight before apply.
REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh2105_color_contractor_rpc

**Migration**: gh2105_color_contractor_rpc.sql
**GitHub**: #2105 (checklist C), #2974
**Tier**: 3B. New SECURITY DEFINER function callable by `authenticated`. R-097 24-hour notice, migration-author protocol, Dustin's approval to apply.
**Status**: DRAFT. Nothing was applied or run.

## What it does

Adds `public.get_claim_color_contractor(p_claim_id uuid)` returning `company_name` and `preferred_brands` for the contractor selected on a claim the caller owns, and nothing else. It replaces the embedded `contractor:contractors(...)` join the colour-selection pages used, which fails for homeowners because they have no SELECT on `public.contractors`.

Deliberately NOT done: a new SELECT policy on `public.contractors`. That would expose phone, email and Stripe columns to every homeowner row-matched by it.

## Decision for review

The pages also read `contractors.phone`, `notification_phones` and `email` (to show "To reach them directly: <phone>" and in a fallback line). This draft does NOT return them: contractor contact details were not part of the question Dustin answered on #2974, and returning them is a disclosure decision (see D-390 on contact redaction). With them dropped the pages use their existing no-phone wording ("Contact your contractor, <name>, to confirm."). If Dustin wants the phone back, add `ct.phone, ct.notification_phones` to this function and re-point `contractorPhone` in both pages; that is a separate decision.

## Pre-apply checks (read-only, run against production and paste results on #2105)

```sql
-- 1. columns exist with the expected types
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE (table_name = 'contractors' AND column_name IN ('company_name','preferred_brands'))
    OR (table_name = 'claims' AND column_name IN ('user_id','selected_contractor_id'))
 ORDER BY table_name, column_name;
-- expect: company_name text, preferred_brands ARRAY, selected_contractor_id uuid, user_id uuid

-- 2. the function does not already exist
SELECT proname FROM pg_proc WHERE proname = 'get_claim_color_contractor';   -- expect 0 rows

-- 3. homeowners really have no SELECT on contractors (the premise)
SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'contractors';
```

## Post-apply proof (run in a rolled-back transaction as each role)

```sql
BEGIN;
-- owner sees exactly the selected contractor's two columns
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', '<owner user_id>')::text, true);
SELECT * FROM public.get_claim_color_contractor('<claim id>');            -- expect 1 row, 2 columns

-- another authenticated user sees nothing
SELECT set_config('request.jwt.claims', json_build_object('sub', '<some other user_id>')::text, true);
SELECT * FROM public.get_claim_color_contractor('<claim id>');            -- expect 0 rows

-- anon cannot call it
RESET ROLE; SET LOCAL ROLE anon;
SELECT * FROM public.get_claim_color_contractor('<claim id>');            -- expect: permission denied for function
ROLLBACK;
```

## Rollback

`gh2105_color_contractor_rpc_rollback.sql` drops the function. Safe at any time: both pages tolerate an RPC error and still load.

## Ordering

Independent of the Edge Function change in the same PR. The pages work before apply (the RPC error leaves a generic contractor name and an unconfirmed brand) but show the real contractor and brand only after it.
