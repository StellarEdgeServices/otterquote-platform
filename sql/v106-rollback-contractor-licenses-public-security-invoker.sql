-- ============================================================================
-- v106 ROLLBACK — restores contractor_licenses_public as a view (v93 body
-- verbatim) and drops get_contractor_licenses_public (GitHub #530)
-- ============================================================================
--
-- Does not restore call sites — the app-side rollback (reverting bids.html
-- and use-bids-data.ts back to .from('contractor_licenses_public')) must
-- ship in the same revert as this SQL, or the app will call a view that
-- exists but a function that no longer does, or vice versa.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_contractor_licenses_public(uuid[]);

CREATE OR REPLACE VIEW public.contractor_licenses_public AS
SELECT
  cl.contractor_id,
  cl.jurisdiction_level,
  cl.municipality,
  cl.license_number,
  cl.expiration_date,
  cl.verification_url
FROM public.contractor_licenses cl
WHERE cl.contractor_id IN (
  SELECT id FROM public.contractors WHERE status IN ('active', 'approved')
);

COMMENT ON VIEW public.contractor_licenses_public IS
'Homeowner-safe projection of contractor_licenses for the bids.html / React '
'credential-education surfaces (D-217/D-218, issue #534). Restored by the '
'v106 rollback (GitHub #530) after the v106 security_invoker migration.';

GRANT SELECT ON public.contractor_licenses_public TO anon;
GRANT SELECT ON public.contractor_licenses_public TO authenticated;

COMMIT;
