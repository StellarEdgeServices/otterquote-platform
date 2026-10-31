-- STATUS (gh-1438, as of 2026-10-30T13:30Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3224_template_verdict_log (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-30 under #3224; the forward file is not applied (production read-only 2026-10-30, project yeszghaspzwwstvsrioa: no contractor_template_verdicts table)
-- REPO COPY: none (not applied)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Reverses gh3224_template_verdict_log.sql. DESTRUCTIVE: drops the verdict log, so every recorded rejection
-- is lost. Roll back the Edge Function (validate-contract-template) FIRST or its lookup will fail closed
-- (HTTP 500 on any scan that would write a validated status). Neither contractor_templates_freeze_verdict nor
-- enforce_template_privileged_columns was changed by the forward file, so neither needs restoring.
BEGIN;
DROP TRIGGER IF EXISTS trg_contractor_templates_log_verdict ON public.contractor_templates;
DROP FUNCTION IF EXISTS public.template_admin_verdict_blocks_auto_validation(uuid);
DROP FUNCTION IF EXISTS public.log_template_admin_verdict();
DROP TRIGGER IF EXISTS trg_ctv_no_truncate ON public.contractor_template_verdicts;
DROP TRIGGER IF EXISTS trg_ctv_append_only ON public.contractor_template_verdicts;
DROP TABLE IF EXISTS public.contractor_template_verdicts;   -- takes its grants (service_role SELECT) and indexes with it
DROP FUNCTION IF EXISTS public.contractor_template_verdicts_append_only();
COMMIT;
