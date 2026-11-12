-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (forward, ledger version 20261108221339); this rollback is NOT run
-- FILE ROLE: rollback file of set gh3460_held_fee_release (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-05 under #3460. Removes only the trigger and function the forward file creates. No database was written to produce this file.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/ beside the filed forward migration.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3460_held_fee_release. Drops the role-settled trigger and the admin function. It does NOT touch partner_fee_events or hover_orders rows:
-- a fee already accrued through this path is real money state and stays (it follows the normal batch/paid path); roles already settled stay settled.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS partner_fee_accrue_on_role_settled ON public.hover_orders;
DROP FUNCTION IF EXISTS public.admin_settle_order_buyer_role(uuid, text, uuid, text, boolean);
COMMIT;
