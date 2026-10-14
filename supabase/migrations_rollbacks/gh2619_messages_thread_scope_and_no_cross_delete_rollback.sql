-- Rollback for gh2619_messages_thread_scope_and_no_cross_delete (gh-2619, second piece).
-- Restores the two cmd ALL policies as they stand after gh2619_messages_selected_contractor_only
-- (ledger 20261014112047; text read from production pg_policies, CLOSE-REVIEW 6168484981).
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
COMMIT;
