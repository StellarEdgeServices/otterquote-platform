-- Rollback for: supabase/migrations/20260928211500_gh2313_partner_lead_consents.sql
-- GitHub: #2313
--
-- Drops public.partner_lead_consents. Nothing else was changed by the forward migration.
--
-- ORDER MATTERS WITH THE EDGE FUNCTION. Roll back in this order:
--   1. Revert or undeploy the meta-leadgen-webhook change that writes this table. With the
--      table gone, every partner lead would fail its consent write (a transient 503, and no
--      partner is registered), so the function must stop writing first.
--   2. Run this file.
--
-- EVIDENCE GUARD. The table holds TCPA call/text consent evidence. This rollback REFUSES to run
-- once it has any row: dropping it would destroy records that cannot be reconstructed. If the
-- rollback is genuinely needed after real partner submissions, export the rows, keep the export
-- under the retention rule, delete the rows by a deliberate separate act, then re-run this file.
-- The guard takes a SHARE lock first so an in-flight insert cannot commit between the count and
-- the DROP.

BEGIN;

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.partner_lead_consents') IS NOT NULL THEN
    LOCK TABLE public.partner_lead_consents IN SHARE MODE;
    EXECUTE 'SELECT count(*) FROM public.partner_lead_consents' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'gh2313 rollback REFUSED: public.partner_lead_consents holds % consent-evidence row(s). Export them, retain the export, delete the rows deliberately, then re-run.', v_rows;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.partner_lead_consents;

COMMIT;
