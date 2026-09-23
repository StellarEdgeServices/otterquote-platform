-- Rollback for: supabase/migrations/20260923211259_gh2122_leads_details_consent.sql
-- GitHub: #2122
--
-- Restores the schema to its pre-migration state: the record_lead_details()
-- function, the lead_consents table, the four leads columns and the
-- rate_limit_config row are removed. No other object is touched (in particular
-- leads_force_safe_insert_defaults, trg_notify_admin_new_router_lead and every
-- policy on public.leads were never changed by the forward migration, so there
-- is nothing to restore there).
--
-- ORDER MATTERS WITH THE EDGE FUNCTION. Roll back in this order:
--   1. Stop the client writing: revert or disable js/router-variant-f.js's call to
--      the record-lead-details Edge Function (or take Arm F off /start).
--   2. Undeploy or revert supabase/functions/record-lead-details -- with the
--      function gone from the database (step below) every call would fail, and
--      with its rate_limit_config row gone check_rate_limit() would fail CLOSED.
--   3. Run this file.
--
-- EVIDENCE GUARD. public.lead_consents holds TCPA consent evidence (D-299). This
-- rollback REFUSES to run once that table has any row: dropping it would destroy
-- legal records that cannot be reconstructed. If the rollback is genuinely needed
-- after Arm F has taken real submissions, export the table first, keep the export
-- under the retention rule, delete the rows by a deliberate, separate act, and
-- only then re-run this file.

BEGIN;

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.lead_consents') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.lead_consents' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'gh2122 rollback REFUSED: public.lead_consents holds % consent-evidence row(s) (D-299). Export them, retain the export, delete the rows deliberately, then re-run.', v_rows;
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.record_lead_details(uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb);

DROP TABLE IF EXISTS public.lead_consents;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS funding_type,
  DROP COLUMN IF EXISTS property_address,
  DROP COLUMN IF EXISTS fbc,
  DROP COLUMN IF EXISTS fbp;

DELETE FROM public.rate_limit_config WHERE function_name = 'record-lead-details';

COMMIT;
