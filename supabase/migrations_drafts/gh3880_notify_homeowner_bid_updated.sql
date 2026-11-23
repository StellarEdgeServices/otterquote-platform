-- STATUS (gh-1438, as of 2026-11-23T12:53:24Z): NOT APPLIED (new draft under #3880; production read by SELECT only on 2026-11-23, project yeszghaspzwwstvsrioa: public.notify_homeowner_bid_updated(uuid) absent)
-- FILE ROLE: forward file of set gh3880_notify_homeowner_bid_updated (rollback is a sibling in this directory; proof is supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs)
-- EVIDENCE: drafted 2026-11-23 under #3880 (P03). pg_policy on public.notifications read by SELECT 2026-11-23: the only authenticated INSERT policy, "Authenticated can insert notifications", has WITH CHECK ((user_id = (SELECT auth.uid())) AND (referral_agent_id IS NULL)). Forward and rollback were proven on a throwaway local PGlite database seeded with the production notifications columns and policies (supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs); NOT run against production.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and the rollback in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3880_notify_homeowner_bid_updated
-- GitHub: #3880 (P03). Tier: 3B (new authenticated-callable SECURITY DEFINER RPC that writes notifications). R-097 24-hour notice before apply. Additive: no policy changes.
-- Rollback: supabase/migrations_drafts/gh3880_notify_homeowner_bid_updated_rollback.sql
--
-- Why: when a contractor changes or renews a bid, the bid form inserts a dashboard 'bid_updated' notification for the homeowner from the
-- contractor's own session. The notifications INSERT policy only lets a user write a row for their own user_id, so the insert is refused
-- (42501) and the homeowner is never told. Loosening that policy would let a contractor write rows for arbitrary users, so the write
-- moves server side, the same way request_bid_renewal (gh-3049) does for the opposite direction.
--
-- What it does: notify_homeowner_bid_updated(p_quote_id uuid) returns boolean. The caller must be authenticated AND own the quote
-- (contractors.user_id = auth.uid() for the quote's contractor); the quote must not be withdrawn. The homeowner (claims.user_id) is read
-- from the quote's own claim, so the caller can only ever notify the homeowner of a claim they have a bid on. It inserts one dashboard
-- 'bid_updated' notification with the wording the bid form used before, and returns true. An identical notification for the same claim
-- inside the last 10 minutes is not inserted again (returns true). Every refusal (no session, unknown quote, someone else's quote,
-- withdrawn quote, claim without a homeowner user_id) returns false with no detail, so the function is not an oracle. The homeowner
-- user_id is never returned.
BEGIN;

CREATE OR REPLACE FUNCTION public.notify_homeowner_bid_updated(p_quote_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim_id uuid;
  v_homeowner uuid;
  v_company text;
  v_msg text;
BEGIN
  IF v_uid IS NULL OR p_quote_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT q.claim_id, c.user_id, k.company_name
    INTO v_claim_id, v_homeowner, v_company
    FROM public.quotes q
    JOIN public.claims c ON c.id = q.claim_id
    JOIN public.contractors k ON k.id = q.contractor_id
   WHERE q.id = p_quote_id
     AND k.user_id = v_uid                      -- caller is the contractor who owns this bid
     AND COALESCE(q.bid_status, 'active') <> 'cancelled';

  IF NOT FOUND OR v_homeowner IS NULL THEN
    RETURN false;
  END IF;

  v_msg := COALESCE(NULLIF(btrim(v_company), ''), 'A contractor')
           || ' has updated their bid for your project. Please review the new figures.';

  -- No repeat of the same notice for the same claim inside 10 minutes (a retried submit must not notify twice).
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id = v_homeowner
       AND n.claim_id = v_claim_id
       AND n.notification_type = 'bid_updated'
       AND n.channel = 'dashboard'
       AND n.message_preview = v_msg
       AND n.created_at > now() - interval '10 minutes'
  ) THEN
    RETURN true;
  END IF;

  INSERT INTO public.notifications (user_id, claim_id, channel, notification_type, recipient, message_preview)
  VALUES (v_homeowner, v_claim_id, 'dashboard', 'bid_updated', '', v_msg);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_homeowner_bid_updated(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_homeowner_bid_updated(uuid) TO authenticated;

COMMENT ON FUNCTION public.notify_homeowner_bid_updated(uuid) IS
  'gh-3880: a contractor tells the homeowner their bid changed. Resolves the homeowner user_id server side from the caller''s own quote, inserts one dashboard bid_updated notification, returns boolean only. 10-minute dedupe per claim.';

DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'notify_homeowner_bid_updated';
  IF NOT r.prosecdef THEN RAISE EXCEPTION 'gh3880: not SECURITY DEFINER'; END IF;
  IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN RAISE EXCEPTION 'gh3880: search_path %', r.proconfig; END IF;
  IF r.anon_x OR r.public_x OR NOT r.auth_x THEN RAISE EXCEPTION 'gh3880: grants wrong'; END IF;
END $$;

COMMIT;
