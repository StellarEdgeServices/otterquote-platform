-- STATUS (gh-1438, as of 2026-10-14): NOT APPLIED
-- FILE ROLE: forward file of set gh2619_messages_thread_scope_and_no_cross_delete (second piece of #2619; round 2 after REVIEW: FAIL 6169771197)
-- EVIDENCE: CLOSE-REVIEW: FAIL comment 6168484981 on #2619 (2026-10-14T12:36:14Z) names two gaps still visible in the live pg_policies text after gh2619_messages_selected_contractor_only (ledger 20261014112047); proof on a throwaway Postgres is supabase/tests/gh2619_messages_thread_scope_proof.sql
-- REPO COPY: none. After a recorded apply, file this forward SQL under its real ledger version in supabase/migrations/; rollback is supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql; pre-flight is supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_pre-flight.md
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Tier 3B: review, R-097 notice, recorded apply.
--
-- gh-2619, the two same-table gaps named in 6067604141, 6164270927 and 6168484981:
--
--   GAP 1  The thread is keyed by claim. After the selection changes, the NEW selected contractor
--          passes the contractor_messages test and reads the PREVIOUS contractor's whole
--          conversation with the homeowner.
--   GAP 2  contractor_messages and homeowner_messages are cmd ALL, so each party can DELETE rows
--          the OTHER party sent (and UPDATE their own sent rows after the fact; an UPDATE of the
--          other party's row is already refused by the live WITH CHECK).
--
-- Change (every new RLS rule is a subset of what the live rule admits; nothing is granted):
--   * Split each ALL policy into a SELECT policy and an INSERT policy. There is then NO
--     UPDATE or DELETE policy for any non-service role, so row-level security refuses both for
--     the homeowner and for every contractor (zero rows match; no error is raised).
--     service_role_messages (ALL, auth.role() = 'service_role') is untouched. Foreign-key
--     ON DELETE CASCADE from claims/profiles is unaffected (referential actions bypass RLS).
--     No client reads-then-updates messages today: dashboard.html, contractor-dashboard.html,
--     MessagesPanel.tsx, Messaging.tsx and actions.ts only SELECT and INSERT (INSERT ... RETURNING
--     id, which needs the new row to pass the SELECT policy; the proof probes that); read_at on
--     messages is never written by a client (the read_at writes in the repo are on notifications).
--   * DATABASE-STAMPED SELECTION TIME (round 2, REVIEW 6169771197 finding 1). New nullable column
--     claims.contractor_selected_at, set by trigger claims_stamp_contractor_selected_at to now()
--     whenever selected_contractor_id changes (including to NULL) and on INSERT with a contractor.
--     The trigger also pins the column on every other UPDATE (NEW := OLD), so no client, owner
--     or otherwise, can set it. This replaces reliance on each writer remembering to set
--     contractor_switched_at: process-dunning (index.ts:677, "Homeowner chose a different
--     contractor") clears selected_contractor_id WITHOUT setting contractor_switched_at, and
--     accept_bid / bids/actions.ts award afterwards; switch-contractor sets contractor_switched_at
--     with the Edge Function clock. The trigger sees every one of those paths, and admin SQL.
--   * Contractor SELECT additionally requires messages.created_at >= the bound, where the bound is
--     coalesce(claims.contractor_selected_at, claims.contractor_switched_at). Claims selected before
--     this migration have contractor_selected_at NULL and fall back to contractor_switched_at (set by
--     switch-contractor), then to "no bound" (as today) when neither is set. No backfill UPDATE is run.
--     The homeowner's own read is unchanged (full history).
--   * messages.created_at is pinned on INSERT (trigger messages_pin_created_at, NEW.created_at := now())
--     for every writer (REVIEW finding 2): a client can no longer plant a row dated in the future,
--     which would otherwise pass every later bound. Both the bound and created_at are now the database
--     clock, which also removes the Edge-Function-vs-database clock skew (finding 3) from every
--     claim selected after this migration.
--   * Contractor INSERT and homeowner INSERT keep exactly the WITH CHECK text now in production.
--
-- Known and accepted behaviours, disclosed:
--   * Re-selection (REVIEW finding 4): a contractor who was switched away and is later selected again
--     on the same claim loses sight of their own earlier conversation (the bound is the latest
--     selection). Removing that would need a per-contractor key on messages (it has no recipient
--     column); a schema change this draft avoids. The homeowner still sees the full history.
--   * Legacy rows: a claim whose selection changed before this migration through a path that did not
--     set contractor_switched_at (process-dunning) has no bound until its next selection change.
--     The pre-flight counts these on production; the next award on such a claim stamps the bound.
--   * ALTER TABLE ... ADD COLUMN (nullable, no default) is a catalogue-only change; it takes a brief
--     ACCESS EXCLUSIVE lock on public.claims.
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

ALTER TABLE public.claims ADD COLUMN contractor_selected_at timestamptz;
COMMENT ON COLUMN public.claims.contractor_selected_at IS 'gh-2619: database-stamped time selected_contractor_id last changed (trigger claims_stamp_contractor_selected_at; clients cannot set it). Lower bound for what the selected contractor may read in messages.';

CREATE FUNCTION public.claims_stamp_contractor_selected_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.contractor_selected_at := CASE WHEN NEW.selected_contractor_id IS NOT NULL THEN now() ELSE NULL END;
  ELSIF NEW.selected_contractor_id IS DISTINCT FROM OLD.selected_contractor_id THEN
    NEW.contractor_selected_at := now();
  ELSE
    NEW.contractor_selected_at := OLD.contractor_selected_at;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claims_stamp_contractor_selected_at
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_stamp_contractor_selected_at();

CREATE FUNCTION public.messages_pin_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER messages_pin_created_at
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_pin_created_at();

DROP POLICY contractor_messages ON public.messages;
DROP POLICY homeowner_messages ON public.messages;

-- Contractor: read only as the claim's selected contractor, and only from the last (database-stamped) selection onward.
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
         AND (coalesce(claims.contractor_selected_at, claims.contractor_switched_at) IS NULL
              OR messages.created_at >= coalesce(claims.contractor_selected_at, claims.contractor_switched_at))
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
