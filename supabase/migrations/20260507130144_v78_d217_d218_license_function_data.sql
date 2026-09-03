-- Migration: v78_d217_d218_license_function_data
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-07T13:01:44Z, recorded in
-- supabase_migrations.schema_migrations as version 20260507130144, name
-- "v78_d217_d218_license_function_data". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

UPDATE public.contractors
SET license_path = 'not_provided'
WHERE license_path IS NULL;

CREATE OR REPLACE FUNCTION public.contractor_has_required_docs(p_contractor_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_cgl     BOOLEAN;
  v_has_wc      BOOLEAN;
  v_has_license BOOLEAN;
  v_legacy      BOOLEAN;
BEGIN
  SELECT
    (coi_file_url IS NOT NULL AND (coi_expires_at IS NULL OR coi_expires_at >= CURRENT_DATE)),
    (
      (wc_carrier IS NOT NULL AND wc_policy_number IS NOT NULL
        AND (wc_expiration_date IS NULL OR wc_expiration_date >= CURRENT_DATE))
      OR
      (wc_cert_file_ref IS NOT NULL
        AND (wc_cert_expiry IS NULL OR wc_cert_expiry >= CURRENT_DATE))
    ),
    (
      EXISTS (SELECT 1 FROM contractor_licenses cl WHERE cl.contractor_id = p_contractor_id)
      OR license_path = 'not_provided'
    ),
    legacy_pre_approval
  INTO v_has_cgl, v_has_wc, v_has_license, v_legacy
  FROM contractors
  WHERE id = p_contractor_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF COALESCE(v_legacy, FALSE) THEN
    RETURN TRUE;
  END IF;

  RETURN COALESCE(v_has_cgl, FALSE)
     AND COALESCE(v_has_wc, FALSE)
     AND COALESCE(v_has_license, FALSE);
END;
$function$;
