-- ============================================================================
-- gh1245_admin_measurements_rls — ROLLBACK
--
-- Reverts admin-measurements.html to non-functional (its pre-existing state
-- before this migration). Safe at any time: removes only the three grants
-- added, restores platform_settings' read allowlist to its prior four keys.
-- ============================================================================

DROP POLICY IF EXISTS "hover_orders_admin_all" ON public.hover_orders;
DROP POLICY IF EXISTS "claims_admin_update" ON public.claims;

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (key = ANY (ARRAY[
    'D204_HARD_FILTER'::text,
    'hover_measurement_price'::text,
    'platform_fee_percentage'::text,
    'skip_hover_in_test'::text
  ]));
