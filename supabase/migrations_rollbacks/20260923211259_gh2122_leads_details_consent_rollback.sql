-- Rollback for: supabase/migrations/20260923211259_gh2122_leads_details_consent.sql
-- GitHub: #2122
--
-- Restores the schema to its pre-migration state: the insert guard's body is put back
-- to its original five assignments, then the record_lead_details() function, the
-- lead_consents table, the four leads columns and the rate_limit_config row are removed.
-- The trigger, trg_notify_admin_new_router_lead and every policy on public.leads were
-- never changed by the forward migration, so there is nothing to restore there.
--
-- THE GUARD IS RESTORED FIRST, ON PURPOSE. The forward migration's guard body names the
-- four new columns; if they were dropped while it was still installed, every INSERT into
-- public.leads would fail. The original body below is the production definition read with
-- pg_get_functiondef on 2026-09-23 (md5 of prosrc 61d154d12d28801c788825ef18199a2a).
--
-- ORDER MATTERS WITH THE EDGE FUNCTION. Roll back in this order:
--   1. Stop the client writing: revert or disable js/router-variant-f.js's call to
--      the record-lead-details Edge Function (or take Arm F off /start).
--   2. Undeploy or revert supabase/functions/record-lead-details -- with the
--      function gone from the database (step below) every call would fail, and
--      with its rate_limit_config row gone check_rate_limit() would fail CLOSED.
--   3. Run this file.
--
-- EVIDENCE GUARD. public.lead_consents holds TCPA consent evidence (D-299) and the
-- four new leads columns hold what visitors typed (funding answer, property
-- address, Meta ids). This rollback REFUSES to run once lead_consents has any row
-- OR any leads row has a value in funding_type / property_address / fbc / fbp:
-- dropping them would destroy records that cannot be reconstructed. If the
-- rollback is genuinely needed after Arm F has taken real submissions, export
-- both, keep the export under the retention rule, remove the rows/values by a
-- deliberate, separate act (DELETE FROM public.lead_consents; UPDATE public.leads
-- SET funding_type = NULL, property_address = NULL, fbc = NULL, fbp = NULL WHERE
-- ...), and only then re-run this file. The guard takes a SHARE lock on
-- lead_consents first, so an insert that is in flight cannot commit between the
-- count and the DROP and be destroyed with the table.

BEGIN;

DO $$
DECLARE
  v_rows bigint;
  v_cols bigint;
BEGIN
  IF to_regclass('public.lead_consents') IS NOT NULL THEN
    LOCK TABLE public.lead_consents IN SHARE MODE;
    EXECUTE 'SELECT count(*) FROM public.lead_consents' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'gh2122 rollback REFUSED: public.lead_consents holds % consent-evidence row(s) (D-299). Export them, retain the export, delete the rows deliberately, then re-run.', v_rows;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'property_address') THEN
    EXECUTE 'SELECT count(*) FROM public.leads WHERE funding_type IS NOT NULL OR property_address IS NOT NULL OR fbc IS NOT NULL OR fbp IS NOT NULL' INTO v_cols;
    IF v_cols > 0 THEN
      RAISE EXCEPTION 'gh2122 rollback REFUSED: % leads row(s) hold funding_type / property_address / fbc / fbp values that dropping the columns would destroy. Export them, retain the export, NULL the values deliberately, then re-run.', v_cols;
    END IF;
  END IF;
END
$$;

-- 1. Restore the original insert guard (must precede the column drops, see the header).
CREATE OR REPLACE FUNCTION public.leads_force_safe_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.created_at        := now();
  NEW.converted_user_id := NULL;
  NEW.role              := NULL;
  NEW.partner_industry  := NULL;
  NEW.alerted_at        := NULL;
  RETURN NEW;
END;
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
