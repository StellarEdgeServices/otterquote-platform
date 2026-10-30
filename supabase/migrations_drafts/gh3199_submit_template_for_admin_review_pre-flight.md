# Pre-Flight: gh3199_submit_template_for_admin_review

**Status**: DRAFT ONLY, NOT APPLIED. Tier 3B (new authenticated-callable SECURITY DEFINER RPC; CREATE OR REPLACE of a status-guard trigger function). Issue: #3199 (clause 6 of #2105; #2717 Q2; design ruled by Ben on #3199, comment 6522660494). R-097 notice before apply. Apply is Marty's, not the builder's.

## Change
1. New `public.submit_template_for_admin_review(p_template_id uuid, p_overrides jsonb, p_missing_fields text[]) RETURNS contractor_templates`, SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE to `authenticated` only. Owner from `auth.uid()`; from-statuses `pending_validation` / `manual_mapping_pending` only; `manual_overrides` and `status` written in one UPDATE.
2. `enforce_template_privileged_columns()` replaced with the live body plus one allowance in the status check (flag `oq.template_submit = 'on'` AND `current_user <> 'authenticated'` AND the one transition). `contractor_templates_freeze_verdict` is NOT changed.

## Why the trigger change is needed (from the live bodies, read 2026-10-30 with pg_get_functiondef)
- `contractor_templates_freeze_verdict`: `IF current_user <> 'authenticated' THEN RETURN NEW` is its first line. Inside a SECURITY DEFINER function owned by `postgres`, `current_user` is `postgres`, so it does not touch the RPC's UPDATE. No change.
- `enforce_template_privileged_columns`: allows a status change only if `request_is_privileged()` (no jwt claims / service_role / `is_admin_email()`), a template admin, or the #510 reset to `pending_validation`. A contractor's JWT is none of these, so the RPC's UPDATE would raise 42501. Proof control: "SECURITY DEFINER update without the flag, on the old guard" -> `error 42501`.
- Production state measured 2026-10-30 (read-only): contractor_templates status counts manual_mapping_pending 7, pending_validation 4, auto_validated 1, admin_validated 1, submitted_for_admin_review 0. Triggers on the table: `contractor_templates_freeze_verdict`, `trg_contractor_templates_updated_at`, `trg_templates_privileged_guard` (all enabled). Owner of the table and both functions: postgres. RLS on; policies `contractor_templates_self`, `contractor_templates_admin`.

## Behavior notes for the reviewer
- `validation_result` is kept (the RPC runs as the function owner, so freeze_verdict's reset does not fire). The reviewer sees the validator's last result next to the mapping.
- `p_overrides` and `p_missing_fields` both NULL = leave `manual_overrides` as stored (the "Request admin review" button). Otherwise `manual_overrides = coalesce(p_overrides,'{}') || {"_missing_fields": p_missing_fields}` when the array is non-empty, the same shape the page wrote before.
- The page offers "Request admin review" for `rejected` rows too (`D199_FAIL_STATES`), but Ben's ruling allows only the two from-statuses, so that click now fails with the RPC error and the page's "Could not submit for admin review: ..." alert. Flagging it; widening the from-list is a one-line change if Ben wants it.
- A second submit of an already-submitted template raises 55000 (not idempotent by design of the ruling).
- Admin queue filter (`admin/template-review/utils.ts`) is unchanged and already lists `submitted_for_admin_review`.

## Proof (no production write)
`bash supabase/tests/gh3199_submit_template_proof_run.sh` (throwaway local Postgres 16.15, production trigger/function bodies, RLS policies and the same roles). Result: `PROOF-OK all 27 checks passed`. Negative controls recorded in the same run: client direct write of overrides+status leaves `pending_validation`; client status-only write leaves `manual_mapping_pending`; definer update without the flag fails 42501; 0 rows in `submitted_for_admin_review` before, 2 after. Refusals proven: other contractor's template and unknown id (both P0002), no session (42501), auto_validated / admin_validated / rejected / already-submitted (55000), null id and non-object overrides (22023), forged GUC plus direct client write (no effect), flag on with another target status (42501), anon cannot execute.

## Verify after apply (read-only SELECTs, then one live submit by a test contractor)
1. `select prosecdef, proconfig from pg_proc where oid = 'public.submit_template_for_admin_review(uuid,jsonb,text[])'::regprocedure;` -> `t`, `{"search_path=public, pg_temp"}`.
2. `select has_function_privilege('anon', 'public.submit_template_for_admin_review(uuid,jsonb,text[])', 'EXECUTE');` -> `f`; same for `authenticated` -> `t`.
3. `select prosrc like '%oq.template_submit%' from pg_proc where proname = 'enforce_template_privileged_columns';` -> `t`; `contractor_templates_freeze_verdict` md5(prosrc) unchanged.
4. After the page change is published: a regular `is_test` contractor's manual-mapping submit, then `select id, status from contractor_templates where id = '<id>';` -> `submitted_for_admin_review`, and the row shows in the admin template-review queue. (This is the #3199 closes-on proof; it is a production write by a test account, so it is the CTO's act at apply time.)

## Rollout order
Apply the migration first (additive RPC + guard allowance, nothing calls the RPC yet), then publish the page. Publishing the page first would make both submit buttons fail with "function not found".

## Rollback
`gh3199_submit_template_for_admin_review_rollback.sql` drops the RPC and restores the production `enforce_template_privileged_columns` body exactly (verbatim from pg_get_functiondef, 2026-10-30). Roll the page back with it (the old page writes the status directly, which the trigger silently rewrites, i.e. the pre-fix behavior). Rows already in `submitted_for_admin_review` stay.
