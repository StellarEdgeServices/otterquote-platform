-- Phase 16 RLS Unit 3 — stop contractor self-resolve of dunning (86e1wpx7y)
-- D-220 Tier-3, Dustin-approved 2026-06-18; D-221 Path A
-- payment_failures is the dunning ledger (dunning_status/resolved_at/next_reminder_at/reminder_count/...).
-- The contractor UPDATE policy let a contractor mark their own unpaid-fee dunning 'resolved' and
-- evade collection. No legitimate contractor write path exists (dunning UI is read-only; all writes
-- are service_role via Stripe webhook + process-dunning, plus admin). Contractors keep SELECT.
-- Rollback: CREATE POLICY "contractor_update_own_payment_failures" ON public.payment_failures
--           FOR UPDATE TO public USING (contractor_id IN (SELECT id FROM contractors WHERE user_id = (select auth.uid())));
DROP POLICY IF EXISTS "contractor_update_own_payment_failures" ON public.payment_failures;
