-- ROLLBACK for 20260904234257_gh1509_w9_gate_retired_policy_key.sql
--
-- Re-creates "Authenticated can read public settings" with exactly the
-- pre-change five-key allowlist (byte-identical to the qual read live
-- from prod before the forward migration -- see pre-flight.md). Reversible
-- with no data loss: no row in platform_settings is altered by either
-- half of this migration, only the policy's key allowlist.

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;

CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (key = ANY (ARRAY[
    'D204_HARD_FILTER'::text,
    'hover_measurement_price'::text,
    'platform_fee_percentage'::text,
    'skip_hover_in_test'::text,
    'measurement_products'::text
  ]));
