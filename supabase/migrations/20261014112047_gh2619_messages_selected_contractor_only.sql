-- STATUS (gh-1438): APPLIED. APPLIED to production (yeszghaspzwwstvsrioa) by CTO RUN 65 re-entry 1 (claim cto-2026-10-14T04:47:56Z) on Dustin's word in chat "Go on 2688" (#2688 comment 6167081184): supabase_migrations.schema_migrations version 20261014112047, name gh2619_messages_selected_contractor_only; evidence #2619 comment 6167206416; ledger statements md5 and byte length equal this file's pre-header-change text.
-- FILE ROLE: forward file of set gh2619_messages_selected_contractor_only
-- EVIDENCE: production read-only 2026-10-08 (pg_policies on public.messages): policy contractor_messages (cmd ALL, roles public) still carries the old predicate with no selected-contractor condition; rolled-back before/after proof is on issue #2619 and in supabase/tests/gh2619_messages_selected_contractor_only_proof.sql
-- REPO COPY: this file (ledger version 20261014112047). The rollback stays at supabase/migrations_rollbacks/gh2619_messages_selected_contractor_only_rollback.sql. NEVER RE-RUN by hand: this is the filed copy under the ledger version (moved from supabase/migrations_drafts/ after the apply, 2026-10-14T11:58:22Z stamp.py; SQL statements unchanged, header comments only).
-- NEVER RE-RUN by hand: applied; see the REPO COPY line above.
--
-- gh-2619 [SECURITY]: the policy contractor_messages on public.messages let ANY
-- contractor holding a quote on a claim read and write the whole message thread
-- between the homeowner and the selected contractor. It never looked at
-- claims.selected_contractor_id, so a bidder who lost (or whose bid was declined
-- or expired) could read the winner's conversation and post into it as a contractor.
--
-- Change: ALTER POLICY contractor_messages so a contractor passes only if BOTH
--   (a) the existing condition holds (the contractor has a quote on the claim), and
--   (b) the contractor is the claim's selected contractor
--       (claims.selected_contractor_id = this user's contractors.id).
-- The new predicate is the old predicate AND (b), in both USING and WITH CHECK, so
-- the set of rows and writes it admits is a strict subset of what it admits today.
-- It cannot grant anything new. Roles, command (ALL), homeowner_messages and
-- service_role_messages are not touched. No table, column, grant or data change.
--
-- Before a contractor is selected they can no longer read or write that claim's
-- thread. Nothing in the product relies on that: the homeowner dashboard lists only
-- claims that already have a selected contractor, and send-message-notification
-- routes homeowner messages to the quote with status 'selected' only.
--
-- (b) reads public.claims as the caller. The existing claims policy "Contractors can
-- view claims for their quotes" lets the selected contractor (who has a quote) read
-- that row, so no SECURITY DEFINER helper is needed (none is added).
--
-- Rollback: supabase/migrations_rollbacks/gh2619_messages_selected_contractor_only_rollback.sql

BEGIN;

ALTER POLICY contractor_messages ON public.messages
  USING (
    claim_id IN (
      SELECT quotes.claim_id
        FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
    AND claim_id IN (
      SELECT claims.id
        FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
  )
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'contractor'
    AND claim_id IN (
      SELECT quotes.claim_id
        FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
    AND claim_id IN (
      SELECT claims.id
        FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
  );

COMMIT;
