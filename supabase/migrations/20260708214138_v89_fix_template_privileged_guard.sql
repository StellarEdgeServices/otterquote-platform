-- v89 — #510: contractors can never REPLACE a contract template (42501).
--
-- Two BEFORE triggers on contractor_templates contradict each other. Postgres
-- fires same-timing triggers in NAME order, so `contractor_templates_freeze_verdict`
-- runs before `trg_templates_privileged_guard`. On a contractor re-upload/re-map,
-- freeze_verdict deterministically resets status->'pending_validation' and
-- validation_result->NULL; the guard then saw a status change it did not cause and
-- raised 42501. INSERT worked, every UPDATE (replace) failed.
--
-- Fix: allow exactly the freeze_verdict reset transition through the guard; every
-- other contractor-driven status change is still blocked, and reviewed_by/
-- reviewed_at/admin_notes remain fully admin-managed. freeze_verdict remains the
-- sole authority on status/validation_result for non-privileged writers, so a
-- contractor still cannot inject an arbitrary verdict.
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
