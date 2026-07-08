-- Rollback v89 — restore the original enforce_template_privileged_columns
-- (blocks ALL contractor status changes; re-introduces the #510 replace bug).
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
  IF NEW.status         IS DISTINCT FROM OLD.status
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
