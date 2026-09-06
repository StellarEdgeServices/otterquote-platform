-- ============================================================================
-- gh1411_vendor_credit_expected — FORWARD
--
-- Tier 3A (additive only): one nullable column on public.hover_orders. No
-- column dropped, renamed, retyped or narrowed; no CHECK constraint touched;
-- no data rewritten. This is the same additive shape as gh1245's own nine
-- columns on this table (20260825112956_gh1245_measurement_manual_fulfillment.sql).
--
-- WHY: D-317 cl. 4 (Dustin, verbatim on #1339): "roofscope applies the first
-- $15 to the cost of the full scope. So there's no loss on the first
-- contractor." The R-097 risk brief for #1411 (Marty, cto-2026-09-02T13:45:25Z)
-- named this exact column: "the code records upgrade_paid_amount and
-- vendor_credit_expected = 15.00 on hover_orders and does not net it against
-- the charge." `upgrade_paid_amount` is the EXISTING `homeowner_charge_amount`
-- column (already generic across buyer roles — see create-measurement-order's
-- paid-order insert, which sets it for contractor buyers too); only the
-- vendor-credit bookkeeping itself is new.
--
-- This is bookkeeping, not a charge adjustment: the contractor is charged the
-- full $25/$55 SQ-tier price regardless, and this column is never netted
-- against that charge in code (measurement-upgrade-order.ts). Whether the
-- vendor credit actually arrives is a manual reconciliation item on the
-- admin fulfilment surface. No refund logic reads or writes this column
-- (R-021 — this build issues none).
--
-- STATUS AT AUTHORING TIME: drafted and included in this PR per D-182, NOT
-- applied by the Code lane (no live DB access in this session; deploy is
-- explicitly out of scope for this tier:3b build). Requires the same
-- Tier 3 / D-182 human approval as gh-1245's own migration before it lands.
-- ============================================================================

ALTER TABLE public.hover_orders
  ADD COLUMN IF NOT EXISTS vendor_credit_expected_cents integer;

COMMENT ON COLUMN public.hover_orders.vendor_credit_expected_cents IS
  'gh-1411 / D-317 cl. 4: cents RoofScope is expected to credit back on the FIRST contractor detailed-measurement upgrade purchase for this claim ($15.00 fixed). Recorded, never netted against homeowner_charge_amount. NULL for every row except the first upgrade purchase on a claim, and for every non-upgrade order.';
