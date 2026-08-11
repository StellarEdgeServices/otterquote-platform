-- ============================================================================
-- v107 ROLLBACK — restores `skip_hover_in_test` to the platform_settings RLS
-- allow-list (GitHub #702)
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (key IN ('D204_HARD_FILTER',
                 'hover_measurement_price',
                 'platform_fee_percentage',
                 'skip_hover_in_test'));

COMMIT;
