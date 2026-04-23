-- ============================================================================
-- v54: D-181 Hover Payment Model
-- ============================================================================
-- Locked April 23, 2026 (ClickUp 86e117ty3). OtterQuote pays Hover directly.
-- Homeowner pays OtterQuote $79 upfront at help-measurements.html. $79 is
-- rebated to the homeowner upon job completion (quotes.payment_status =
-- 'succeeded') on a quote tied to the same claim.
--
-- Homeowners who do not complete a project with an OtterQuote contractor keep
-- their Hover report; the $79 is retained. OtterQuote controls the Hover order
-- and earns volume discounts over time.
--
-- Schema changes (additive; non-destructive):
--   hover_orders gains:
--     * homeowner_charge_amount           INT           (cents)
--     * homeowner_stripe_payment_intent_id TEXT
--     * rebate_due                        BOOLEAN       DEFAULT false
--     * rebate_paid_at                    TIMESTAMPTZ
--   platform_settings row:
--     * hover_measurement_price = 7900 (cents). Authoritative server-side price.
--
-- Note: The legacy columns amount_charged (NUMERIC), stripe_payment_id (TEXT),
-- rebated (BOOLEAN), and rebate_stripe_id (TEXT) from v2-migration.sql remain
-- in place but are not used by the D-181 flow. Cleanup can be done later.
--
-- Applied via Supabase MCP apply_migration on April 23, 2026.
-- ============================================================================

BEGIN;

-- ── 1. Add D-181 columns to hover_orders ──────────────────────────────────
ALTER TABLE public.hover_orders
  ADD COLUMN IF NOT EXISTS homeowner_charge_amount            INTEGER,
  ADD COLUMN IF NOT EXISTS homeowner_stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS rebate_due                         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS rebate_paid_at                     TIMESTAMPTZ;

COMMENT ON COLUMN public.hover_orders.homeowner_charge_amount IS
  'D-181: Amount the homeowner paid for Hover measurements, in cents.';
COMMENT ON COLUMN public.hover_orders.homeowner_stripe_payment_intent_id IS
  'D-181: Stripe PaymentIntent ID for the homeowner Hover charge. Used as the refund source on rebate.';
COMMENT ON COLUMN public.hover_orders.rebate_due IS
  'D-181: True when a rebate is owed (homeowner has paid, job not yet completed). Set true by create-hover-order, false by process-hover-rebate after refund.';
COMMENT ON COLUMN public.hover_orders.rebate_paid_at IS
  'D-181: Timestamp the rebate was issued. NULL until Stripe refund succeeds. Used as the idempotency guard.';

-- Index the PI id so process-hover-rebate can look up by claim quickly.
CREATE INDEX IF NOT EXISTS idx_hover_orders_rebate_due
  ON public.hover_orders (rebate_due)
  WHERE rebate_due = true AND rebate_paid_at IS NULL;

-- ── 2. Seed platform_settings with the authoritative Hover price ─────────
-- platform_settings is the source of truth for the charge amount. The
-- create-payment-intent EF reads this value server-side and will NOT trust
-- any client-sent amount for charge_type='hover_measurement' (Deploy Review
-- Checklist item #25 — amount validated server-side).
-- platform_settings.value is JSONB; cast the integer price to jsonb.
INSERT INTO public.platform_settings (key, value)
VALUES ('hover_measurement_price', to_jsonb(7900))
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Confirm the columns were added:
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'hover_orders'
--    AND column_name IN ('homeowner_charge_amount',
--                        'homeowner_stripe_payment_intent_id',
--                        'rebate_due',
--                        'rebate_paid_at');
--
-- Confirm the platform_settings row exists:
-- SELECT ke