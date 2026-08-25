-- ============================================================================
-- gh1245_admin_measurements_rls
--
-- Tier 3A (additive only): three new RLS policies, one existing policy
-- redefined to add a single key to its allowlist array. No column dropped,
-- no existing policy's access narrowed, no data touched.
--
-- WHY: verifying gh-1245 (measurement purchase go-live) before closing it
-- found that admin-measurements.html — merged in PR #1246 — cannot actually
-- function as an admin tool. It was built assuming an admin session can read
-- across all hover_orders rows, write fulfillment data to them, and mirror
-- results onto claims.hover_measurements, the same way every other admin
-- page in this repo works. None of those grants exist:
--
--   * hover_orders had exactly one policy: SELECT scoped to
--     user_id = auth.uid(). No UPDATE policy existed at all — for ANY role,
--     admin included. The fulfillment save in admin-measurements.html would
--     fail outright.
--   * claims had UPDATE scoped to user_id = auth.uid() only. The mirror
--     write to claims.hover_measurements for a customer's claim (never the
--     admin's own) would be silently rejected by RLS.
--   * platform_settings' client-readable key allowlist did not include
--     'measurement_products', so admin-measurements.html's own catalog read
--     (line 326) would return nothing.
--
-- Every other admin-only table in this schema (payout_approvals,
-- platform_fee_config, referral_agents, contractor_templates,
-- warranty_manifest_drift) already grants access this same way, via the
-- existing is_admin_email() function — the SAME check
-- admin-measurements.html's own client-side gate uses
-- (user.email === 'dustinstohler1@gmail.com'), just enforced at the data
-- layer instead of only in page JS. This migration brings hover_orders,
-- claims and platform_settings in line with that established pattern —
-- it does not invent a new one.
--
-- SCOPE NOTE ON claims: this is the first admin RLS grant on claims in this
-- schema (grep of admin-*.html confirms admin-measurements.html is the only
-- admin page that writes to claims directly). Postgres RLS cannot scope an
-- UPDATE policy to a single column, so this necessarily grants admin UPDATE
-- on the whole row, not just hover_measurements. Kept to UPDATE only (no
-- ALL, no INSERT/DELETE) to hold the grant to the minimum the feature needs.
-- The admin account already has service-role access to every claim through
-- other tools, so this does not widen what is achievable — only what
-- admin-measurements.html can do through the anon-key client path it was
-- built to use.
-- ============================================================================

CREATE POLICY "hover_orders_admin_all" ON public.hover_orders
  FOR ALL
  USING (is_admin_email())
  WITH CHECK (is_admin_email());

CREATE POLICY "claims_admin_update" ON public.claims
  FOR UPDATE
  USING (is_admin_email())
  WITH CHECK (is_admin_email());

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
