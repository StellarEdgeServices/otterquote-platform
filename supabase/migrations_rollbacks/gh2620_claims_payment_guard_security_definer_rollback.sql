-- STATUS (gh-1438, as of 2026-10-08T16:39:44Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2620_claims_payment_guard_security_definer (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2620; the function text and grants below are the live ones read 2026-10-08 (SECURITY INVOKER; ACL =X, postgres, anon, authenticated, service_role)
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2620 ROLLBACK for supabase/migrations_drafts/gh2620_claims_payment_guard_security_definer.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into
-- supabase/migrations/ -- the CLI would replay it FORWARD and undo the fix it exists to revert.
-- Restores SECURITY INVOKER and the previous grants. Rolling back brings the defect back:
-- every React-app award is refused again. No data is touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_enforce_payment_method_on_award()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_has_pm boolean;
BEGIN
  IF NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded' THEN
    IF NEW.selected_contractor_id IS NULL THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT has_payment_method INTO v_has_pm
      FROM public.contractors
     WHERE id = NEW.selected_contractor_id;

    IF v_has_pm IS NOT TRUE THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.claims_enforce_payment_method_on_award() TO PUBLIC, anon, authenticated, service_role;

COMMIT;
