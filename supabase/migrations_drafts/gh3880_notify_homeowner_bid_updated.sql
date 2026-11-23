-- STATUS (gh-1438, as of 2026-11-23T12:53:24Z): NOT APPLIED (new draft under #3880; production read by SELECT only on 2026-11-23, project yeszghaspzwwstvsrioa: public.notify_homeowner_bid_updated(uuid) absent)
-- FILE ROLE: forward file of set gh3880_notify_homeowner_bid_updated (rollback is a sibling in this directory; proof is supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs)
-- EVIDENCE: drafted 2026-11-23 under #3880 (P03). pg_policy on public.notifications read by SELECT 2026-11-23: the only authenticated INSERT policy, "Authenticated can insert notifications", has WITH CHECK ((user_id = (SELECT auth.uid())) AND (referral_agent_id IS NULL)). Forward and rollback were proven on a throwaway local PGlite database seeded with the production notifications columns and policies (supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs); NOT run against production.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and the rollback in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3880_notify_homeowner_bid_updated
-- GitHub: #3880 (P03). Tier: 3A (new function plus EXECUTE grant only: no table, column, RLS policy, trigger, email or cron change; production function absent today, so the apply is additive and the rollback is DROP FUNCTION). The function writes in-app notification text to another user, but only inside the gate below. Tier 3A was the reviewer's reading on PR #3893 (REVIEW: FAIL comment 7102937994) and is the cto108-fix3893 worker's reconciliation; the apply decision stays with the orchestrator.
-- Rollback: supabase/migrations_drafts/gh3880_notify_homeowner_bid_updated_rollback.sql
--
-- Why: when a contractor changes or renews a bid, the bid form inserts a dashboard 'bid_updated' notification for the homeowner from the
-- contractor's own session. The notifications INSERT policy only lets a user write a row for their own user_id, so the insert is refused
-- (42501) and the homeowner is never told. Loosening that policy would let a contractor write rows for arbitrary users, so the write
-- moves server side, the same way request_bid_renewal (gh-3049) does for the opposite direction.
--
-- What it does: notify_homeowner_bid_updated(p_quote_id uuid) returns boolean. It writes only when a notice is DUE, and returns false
-- (no row, no detail, so it is not an oracle) otherwise. The gate, using the status values read from production on 2026-11-23:
--   1. caller is authenticated and owns the quote (contractors.user_id = auth.uid());
--   2. the bid is live: quotes.status = 'submitted' AND quotes.bid_status = 'active' (refuses declined, selected, superseded, cancelled/withdrawn,
--      expired) AND quotes.expires_at is null or in the future;
--   3. the claim is still open for bids: claims.status IN ('active','bidding') AND contract_signed_at IS NULL AND selected_contractor_id IS NULL
--      (refuses awarded, contract_signed and every pre-bidding state);
--   4. the bid actually CHANGED: quotes.updated_at is newer than the last bid_updated notice written for this same quote (this is what a
--      Renew Bid / Change Bid save does through the set_updated_at trigger), so a repeated call with no new save writes nothing;
--   5. at most ONE UNREAD notice per quote: while the homeowner has not yet read the previous notice for this quote, no second row is added.
-- The homeowner banner on /bids counts unread bid_updated rows for the claim and shows "N contractors updated their bids", so rules 4 and 5
-- keep it at one row per contractor bid: repeated renewals by the same contractor cannot inflate the count. The quote id is carried in the
-- row's recipient column as 'quote:<uuid>' (empty for every dashboard row today and read by nothing) so the bound does not depend on the text.
-- Recipient (claims.user_id) and message text are derived server side from the quote; the caller supplies only the quote id. The homeowner
-- user_id is never returned. Wording is unchanged from the old client string (no new customer-facing text).
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
  v_updated timestamptz;
  v_last timestamptz;
  v_tag text;
BEGIN
  IF v_uid IS NULL OR p_quote_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT q.claim_id, c.user_id, k.company_name, q.updated_at
    INTO v_claim_id, v_homeowner, v_company, v_updated
    FROM public.quotes q
    JOIN public.claims c ON c.id = q.claim_id
    JOIN public.contractors k ON k.id = q.contractor_id
   WHERE q.id = p_quote_id
     AND k.user_id = v_uid                                   -- caller is the contractor who owns this bid
     AND q.status = 'submitted'                              -- not declined / selected
     AND q.bid_status = 'active'                             -- not cancelled (withdrawn) / superseded / expired
     AND (q.expires_at IS NULL OR q.expires_at > now())
     AND c.status IN ('active', 'bidding')                   -- not awarded / contract_signed / pre-bidding
     AND c.contract_signed_at IS NULL
     AND c.selected_contractor_id IS NULL;

  IF NOT FOUND OR v_homeowner IS NULL THEN
    RETURN false;
  END IF;

  v_tag := 'quote:' || p_quote_id::text;

  -- Bound 5: one unread notice per quote.
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id = v_homeowner AND n.claim_id = v_claim_id
       AND n.notification_type = 'bid_updated' AND n.channel = 'dashboard'
       AND n.recipient = v_tag AND n.read_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  -- Rule 4: the bid must have changed since the last notice for this quote.
  SELECT max(n.created_at) INTO v_last
    FROM public.notifications n
   WHERE n.user_id = v_homeowner AND n.claim_id = v_claim_id
     AND n.notification_type = 'bid_updated' AND n.channel = 'dashboard' AND n.recipient = v_tag;
  IF v_last IS NOT NULL AND (v_updated IS NULL OR v_updated <= v_last) THEN
    RETURN false;
  END IF;

  v_msg := COALESCE(NULLIF(btrim(v_company), ''), 'A contractor')
           || ' has updated their bid for your project. Please review the new figures.';

  INSERT INTO public.notifications (user_id, claim_id, channel, notification_type, recipient, message_preview)
  VALUES (v_homeowner, v_claim_id, 'dashboard', 'bid_updated', v_tag, v_msg);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_homeowner_bid_updated(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_homeowner_bid_updated(uuid) TO authenticated;

COMMENT ON FUNCTION public.notify_homeowner_bid_updated(uuid) IS
  'gh-3880: a contractor tells the homeowner their bid changed. Resolves the homeowner user_id server side from the caller''s own quote, inserts one dashboard bid_updated notification only when the bid is live, the claim is open and the bid changed since the last notice, at most one unread notice per quote; returns boolean only.';

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
