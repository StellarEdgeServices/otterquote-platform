-- Rollback for gh2619_messages_thread_scope_and_no_cross_delete (gh-2619, second piece).
-- Restores the two cmd ALL policies as they stand after gh2619_messages_selected_contractor_only
-- (ledger 20261014112047; text read from production pg_policies, CLOSE-REVIEW 6168484981).
-- Also removes claims.contractor_selected_at, its trigger and messages_pin_created_at.
-- Restoring it re-opens GAP 1 (new selected contractor reads the previous thread) and
-- GAP 2 (each party can UPDATE/DELETE the other's rows).
BEGIN;
DROP POLICY IF EXISTS contractor_messages_select ON public.messages;
DROP POLICY IF EXISTS contractor_messages_insert ON public.messages;
DROP POLICY IF EXISTS homeowner_messages_select ON public.messages;
DROP POLICY IF EXISTS homeowner_messages_insert ON public.messages;

CREATE POLICY contractor_messages ON public.messages
  USING (
    claim_id IN (
      SELECT quotes.claim_id FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
    AND claim_id IN (
      SELECT claims.id FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid))))
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'contractor'
    AND claim_id IN (
      SELECT quotes.claim_id FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
    AND claim_id IN (
      SELECT claims.id FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid))));

CREATE POLICY homeowner_messages ON public.messages
  USING (
    claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)))
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'homeowner'
    AND claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)));

-- Round 2 objects (policies above no longer reference the column, so it can go).
DROP TRIGGER IF EXISTS messages_pin_created_at ON public.messages;
DROP FUNCTION IF EXISTS public.messages_pin_created_at();
DROP TRIGGER IF EXISTS claims_stamp_contractor_selected_at ON public.claims;
DROP FUNCTION IF EXISTS public.claims_stamp_contractor_selected_at();
-- Drops the stamps (not recoverable afterwards; the column is only ever read by the policies removed above).
ALTER TABLE public.claims DROP COLUMN IF EXISTS contractor_selected_at;
COMMIT;
