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
--   * DATABASE-STAMPED RELEASE TIME (round 3; round 2 stamped on every selection change and hid
--     pre-award messages from the winner, REVIEW 6170220911 finding 1). New nullable column
--     claims.contractor_released_at, set by trigger claims_stamp_contractor_released_at to now() only
--     when a contractor LOSES the claim: OLD.selected_contractor_id is not null and it changes, to NULL
--     or to another id. NULL -> contractor (an award) keeps the old value. So the winner still reads
--     the homeowner's messages written before the first award or while the claim was back in bidding,
--     and the previous contractor's thread stays hidden. For client roles (authenticated, anon) the
--     trigger also pins the column on every other UPDATE and nulls it on INSERT, so no client can set
--     it; service_role and admin sessions may set it (restores). This replaces reliance on each writer
--     setting contractor_switched_at: process-dunning (index.ts:677, "Homeowner chose a different
--     contractor") clears selected_contractor_id WITHOUT it, and accept_bid / bids/actions.ts award
--     afterwards; switch-contractor sets contractor_switched_at with the Edge Function clock.
--   * Contractor SELECT additionally requires messages.created_at >= the bound, where the bound is
--     coalesce(claims.contractor_released_at, claims.contractor_switched_at); no bound when both are
--     NULL (as today). The homeowner's own read is unchanged (full history).
--   * NO BACKFILL, A GUARD INSTEAD (round 4, REVIEW 6170620390 finding 1). Round 3 backfilled legacy
--     claims from message heuristics; the review showed the heuristic both under-hides (a homeowner
--     message written for the old contractor after that contractor's last reply stays visible to the
--     next winner) and over-hides (a sole contractor loses their own thread after a pre-#2622
--     non-selected bidder posted; a never-awarded claim hides pre-award questions). Both UPDATEs are
--     removed. Instead the migration RAISEs, aborting, when any claim that is not is_test (is_test IS
--     NOT TRUE, so NULL counts as real) is in one of three legacy sets:
--       (A) no selected contractor and the thread holds contractor-sent messages;
--       (B) a selected contractor and the thread holds contractor-sent messages from a different
--           contractor (a former bidder or a former selected contractor);
--       (C) a payment_failures row with dunning_status = 'contractor_out' (process-dunning released
--           the contractor without contractor_switched_at).
--     The message names the count per set. A non-zero count means STOP: the set only applies while
--     production has no real exposure (measured 2026-10-14: 4 messages, none on real claims,
--     CLOSE-REVIEW 6168484981); come back for a data decision (per-claim real release times from
--     payment_failures.resolved_at / contractor_switched_at / quotes.cancelled_at, or a hand review).
--     The guard is read-only. What it covers: legacy claims a real homeowner or contractor could be
--     in. What it does not cover: is_test claims in sets A to C keep today's unbounded reads for the
--     next winner (test data only); a claim that lost a contractor through a path that left no trace in
--     any of the three sets; and any real exposure that appears between the pre-flight and the apply
--     (the guard runs inside the apply transaction, so it sees the data as of the apply).
--   * messages.created_at is pinned on INSERT for CLIENT roles only (trigger messages_pin_created_at:
--     NEW.created_at := now() when current_user is authenticated or anon), so a client cannot plant a
--     future-dated row that passes every later bound; service_role and admin sessions keep whatever
--     they write (restores, backfills). The bound and created_at are both the database clock for any
--     claim released after this migration, which removes the Edge-Function-vs-database skew (finding 3).
--   * Contractor INSERT and homeowner INSERT keep exactly the WITH CHECK text now in production.
--
-- Known and accepted behaviours, disclosed:
--   * Re-selection (REVIEW finding 4): a contractor who was switched away and is later selected again
--     on the same claim loses sight of their own earlier conversation (the bound is the latest
--     release). Removing that would need a per-contractor key on messages (it has no recipient
--     column); a schema change this draft avoids. The homeowner still sees the full history.
--   * Messages the homeowner wrote while the claim was unselected are shown to the next winner
--     (only messages from before the previous contractor's release are hidden). A message written
--     by the homeowner for the previous contractor in the same instant as the release is not hidden.
--   * created_at pin and the client-role test use current_user; a SECURITY DEFINER function that
--     inserts into messages on a client's behalf would run as its owner and is not pinned (none exists).
--   * ALTER TABLE ... ADD COLUMN (nullable, no default) is a catalogue-only change; it takes a brief
--     ACCESS EXCLUSIVE lock on public.claims.
--
-- Order gate: raises unless gh2619_messages_selected_contractor_only is already live. Then the legacy guard (above).
-- SET LOCAL lock_timeout = '5s' (as gh2107, gh1925, gh2559): if the ACCESS EXCLUSIVE locks cannot be had in 5 seconds the whole transaction fails and nothing changes.
-- Rollback: supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

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

-- Legacy guard (replaces the round 3 backfill): refuse to apply while any real claim is in a legacy set.
DO $guard$
DECLARE
  n_a int; n_b int; n_c int;
BEGIN
  SELECT count(*) INTO n_a
    FROM public.claims cl
   WHERE cl.is_test IS NOT TRUE
     AND cl.selected_contractor_id IS NULL
     AND EXISTS (SELECT 1 FROM public.messages m WHERE m.claim_id = cl.id AND m.sender_role = 'contractor');
  SELECT count(DISTINCT cl.id) INTO n_b
    FROM public.claims cl
    JOIN public.messages m ON m.claim_id = cl.id AND m.sender_role = 'contractor'
   WHERE cl.is_test IS NOT TRUE
     AND cl.selected_contractor_id IS NOT NULL
     AND m.sender_id IS DISTINCT FROM (SELECT k.user_id FROM public.contractors k WHERE k.id = cl.selected_contractor_id);
  SELECT count(DISTINCT cl.id) INTO n_c
    FROM public.claims cl
    JOIN public.payment_failures pf ON pf.claim_id = cl.id AND pf.dunning_status = 'contractor_out'
   WHERE cl.is_test IS NOT TRUE;
  IF n_a + n_b + n_c > 0 THEN
    RAISE EXCEPTION 'gh2619 thread-scope guard: % non-test claim(s) already lost a contractor or hold another contractor''s messages (A unselected with contractor messages: %; B selected with another contractor''s messages: %; C dunning contractor_out: %). Stop: this set only applies while production has no real exposure; come back for a data decision.', n_a + n_b + n_c, n_a, n_b, n_c;
  END IF;
END
$guard$;

ALTER TABLE public.claims ADD COLUMN contractor_released_at timestamptz;
COMMENT ON COLUMN public.claims.contractor_released_at IS 'gh-2619: database-stamped time a contractor last lost this claim (trigger claims_stamp_contractor_released_at; client roles cannot set it). Lower bound for what the selected contractor may read in messages.';

CREATE FUNCTION public.claims_stamp_contractor_released_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.contractor_released_at := NULL;
    END IF;
  ELSIF OLD.selected_contractor_id IS NOT NULL
        AND NEW.selected_contractor_id IS DISTINCT FROM OLD.selected_contractor_id THEN
    NEW.contractor_released_at := now();
  ELSIF current_user IN ('authenticated', 'anon') THEN
    NEW.contractor_released_at := OLD.contractor_released_at;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claims_stamp_contractor_released_at
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_stamp_contractor_released_at();

CREATE FUNCTION public.messages_pin_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER messages_pin_created_at
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_pin_created_at();

DROP POLICY contractor_messages ON public.messages;
DROP POLICY homeowner_messages ON public.messages;

-- Contractor: read only as the claim's selected contractor, and only from the last (database-stamped) release of the claim onward.
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
         AND (coalesce(claims.contractor_released_at, claims.contractor_switched_at) IS NULL
              OR messages.created_at >= coalesce(claims.contractor_released_at, claims.contractor_switched_at))
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
