-- STATUS (gh-1438, as of 2026-10-30): NOT APPLIED
-- FILE ROLE: rollback of set gh3199_submit_template_for_admin_review
-- EVIDENCE: drafted 2026-10-30 under #3199. Function body below is the production definition read with pg_get_functiondef on 2026-10-30 (read-only), reproduced verbatim.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Rows already in submitted_for_admin_review stay as they are (admin-managed statuses). Roll back the page change (d199-validation.tsx) first or in the same release: the old page would write the status directly again.
BEGIN;

DROP FUNCTION IF EXISTS public.submit_template_for_admin_review(uuid, jsonb, text[]);

CREATE OR REPLACE FUNCTION public.enforce_template_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.request_is_privileged()
     OR EXISTS (SELECT 1 FROM public.contractors
                 WHERE user_id = (SELECT auth.uid())
                   AND template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  -- #510: permit the freeze_verdict re-validation reset (status->pending_validation
  -- + validation_result->NULL) that accompanies a template re-upload/re-map.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       NEW.status = 'pending_validation'
       AND NEW.validation_result IS NULL
       AND (
         NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path
         OR NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides
         OR NEW.trade IS DISTINCT FROM OLD.trade
         OR NEW.funding_type IS DISTINCT FROM OLD.funding_type
       )
     ) THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
