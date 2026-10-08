-- Rollback for gh2619_messages_selected_contractor_only (gh-2619).
-- Restores the policy text read from production pg_policies on 2026-10-08.
-- Restoring it re-opens the hole: any contractor with a quote reads and writes the thread.
BEGIN;
ALTER POLICY contractor_messages ON public.messages
  USING (
    claim_id IN (
      SELECT quotes.claim_id FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid))))
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'contractor'
    AND claim_id IN (
      SELECT quotes.claim_id FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid))));
COMMIT;
