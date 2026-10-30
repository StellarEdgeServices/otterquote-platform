<!--
STATUS (gh-1438, as of 2026-10-30T13:30Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3224_template_verdict_log (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3224; production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): table absent
REPO COPY: none (not applied)
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# gh3224 pre-flight (Tier 3B, D-199 legal gate)

Additive only: one new table, two functions, one AFTER trigger on `contractor_templates`, a backfill of rows already in `rejected` / `admin_validated`. No existing function or policy is replaced.

1. Confirm absent: `select to_regclass('public.contractor_template_verdicts');` returns null.
2. Confirm the two live trigger bodies still match what the proof assumes (`pg_get_functiondef` of `contractor_templates_freeze_verdict` and `enforce_template_privileged_columns`); this set does not change them, so PR #3214 may be applied before or after.
3. Apply the forward file, then: `select count(*) from contractor_template_verdicts;` equals the number of `rejected` + `admin_validated` rows (13 rows live on 2026-10-30: 0 + 1).
4. Only then deploy validate-contract-template (PR for #3224). Deploy order matters: the new code fails closed if the reader function is missing.
5. Rollback: deploy the previous Edge Function first, then run the rollback file (drops the log; recorded rejections are lost).
6. Contractor-visible new string (LEGAL-READ): the `notice` in the 200 response when a previously rejected template is sent to admin review.
