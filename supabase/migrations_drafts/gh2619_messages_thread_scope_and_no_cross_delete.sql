-- STATUS (gh-1438, as of 2026-10-14): NOT APPLIED
-- FILE ROLE: forward file of set gh2619_messages_thread_scope_and_no_cross_delete (second piece of #2619)
-- EVIDENCE: CLOSE-REVIEW: FAIL comment 6168484981 on #2619 (2026-10-14T12:36:14Z) names two gaps still visible in the live pg_policies text after gh2619_messages_selected_contractor_only (ledger 20261014112047); proof on a throwaway Postgres is supabase/tests/gh2619_messages_thread_scope_proof.sql
-- REPO COPY: none. After a recorded apply, file this forward SQL under its real ledger version in supabase/migrations/; rollback is supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Tier 3B: review, R-097 notice, recorded apply.
--
-- gh-2619, the two same-table gaps named in 6067604141, 6164270927 and 6168484981:
--
--   GAP 1  The thread is keyed by claim. After switch-contractor, the NEW selected contractor
--          passes the contractor_messages test and reads the PREVIOUS contractor's whole
--          conversation with the homeowner.
--   GAP 2  contractor_messages and homeowner_messages are cmd ALL, so each party can UPDATE or
--          DELETE rows the OTHER party sent (and edit their own after the fact).
--
-- Change (every new rule is a subset of what the live rule admits; nothing is granted):
--   * Split each ALL policy into a SELECT policy and an INSERT policy. There is then NO
--     UPDATE or DELETE policy for any non-service role, so row-level security refuses both for
--     the homeowner and for every contractor (zero rows match; no error is raised).
--     service_role_messages (ALL, auth.role() = 'service_role') is untouched. Foreign-key
--     ON DELETE CASCADE from claims/profiles is unaffected (referential actions bypass RLS).
--     No client reads-then-updates messages today: dashboard.html, contractor-dashboard.html,
--     MessagesPanel.tsx, Messaging.tsx and actions.ts only SELECT and INSERT; read_at on
--     messages is never written by a client (the read_at writes in the repo are on
--     notifications). Verified by grep of the repo at this commit.
--   * Contractor SELECT additionally requires that the message was created at or after
--     claims.contractor_switched_at when that column is set. switch-contractor sets it (and
--     clears selected_contractor_id) in one UPDATE, so a contractor selected after a switch sees
--     only messages from the switch onward and never the previous contractor's thread. When the
--     claim was never switched (contractor_switched_at IS NULL) the selected contractor sees the
--     whole thread, as today. The homeowner's own read is unchanged (full history).
--   * Contractor INSERT and homeowner INSERT keep exactly the WITH CHECK text now in production.
--
-- Known limit, disclosed: the lower bound exists only where contractor_switched_at was set.
-- A selected_contractor_id changed by any path that does not set it (no such path in the repo;
-- admin SQL by hand) would not scope the thread. messages has no recipient column, so a
-- per-contractor key would need a schema change; this draft avoids one.
--
-- Changed behaviour a user can see: a contractor selected after a switch no longer sees messages
-- sent before the switch; nobody can edit or delete a sent message from the app (no such control
-- exists today).
--
-- Order gate: raises unless gh2619_messages_selected_contractor_only is already live.
-- Rollback: supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql

BEGIN;

DO $gate$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'messages'
                    AND policyname = 'contractor_messages' AND cmd = 'ALL'
                    AND qual LIKE '%selected_contractor_id%' AND with_check LIKE '%selected_contractor_id%') THEN
    RAISE EXCEPTION 'gh2619 thread-scope: contractor_messages (ALL) with the selected_contractor_id term is not live; apply gh2619_messages_selected_contractor_only first, or this set was already applied';
  END IF;
END
$gate$;

DROP POLICY contractor_messages ON public.messages;
DROP POLICY homeowner_messages ON public.messages;

-- Contractor: read only as the claim's selected contractor, and only from the last switch onward.
CREATE POLICY contractor_messages_select ON public.messages
  FOR SELECT
  USING (
    claim_id IN (
      SELECT quotes.claim_id
        FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
    AND EXISTS (
      SELECT 1
        FROM claims
       WHERE claims.id = messages.claim_id
         AND claims.selected_contractor_id = (
           SELECT contractors.id FROM contractors
            WHERE contractors.user_id = (SELECT auth.uid() AS uid)
         )
         AND (claims.contractor_switched_at IS NULL
              OR messages.created_at >= claims.contractor_switched_at)
    )
  );

-- Contractor: insert as the selected contractor with a quote (unchanged from the live WITH CHECK).
CREATE POLICY contractor_messages_insert ON public.messages
  FOR INSERT
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

-- Homeowner: read the whole thread on their own claims (unchanged USING).
CREATE POLICY homeowner_messages_select ON public.messages
  FOR SELECT
  USING (
    claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid))
  );

-- Homeowner: insert as the homeowner on their own claims (unchanged WITH CHECK).
CREATE POLICY homeowner_messages_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'homeowner'
    AND claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid))
  );

COMMIT;
