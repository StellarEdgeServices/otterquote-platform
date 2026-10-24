-- STATUS (gh-1438, as of 2026-10-24): NOT APPLIED
-- FILE ROLE: forward file of set gh3049_request_bid_renewal (rollback is a sibling in this directory; proof is supabase/tests/gh3049_request_bid_renewal_proof.sql)
-- EVIDENCE: drafted 2026-10-24 under #3049. No database was written to produce this file. Proof run on a scratch local Postgres 16 with stub tables (see PR body).
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and the rollback in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3049_request_bid_renewal
-- GitHub: #3049 (P03). Tier: 3B (new authenticated-callable SECURITY DEFINER RPC that writes notifications). R-097 notice.
--
-- Why: a homeowner asking an expired bidder for an updated bid could never notify them. The notification row needs the
-- contractor's private contractors.user_id, which a homeowner session cannot read (get_contractors_public omits it, #3042) and
-- cannot write for anyone but itself (notifications INSERT policy is scoped to own user_id, p16). So the lookup and the insert
-- move server side.
--
-- What it does: request_bid_renewal(p_quote_id uuid) returns boolean. The caller must be authenticated AND own the claim the quote
-- is on (claims.user_id = auth.uid()); the quote must not be withdrawn. It resolves the bidding contractor's user_id from the quote
-- itself, so the caller can only ever reach a contractor that has a bid on the caller's own claim. It inserts one dashboard
-- 'bid_renewal_requested' notification with the same message wording the client used before, and returns true. A repeat request for
-- the same quote within 24 hours inserts nothing and returns true (no notification spam). Every refusal (no session, unknown quote,
-- someone else's claim, withdrawn quote, contractor without a user_id) returns false with no detail, so the function is not an oracle
-- for quote ids or contractor identity. The contractor user_id is never returned.
BEGIN;

CREATE OR REPLACE FUNCTION public.request_bid_renewal(p_quote_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim_id uuid;
  v_address text;
  v_contractor_user uuid;
BEGIN
  IF v_uid IS NULL OR p_quote_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT q.claim_id, c.property_address, k.user_id
    INTO v_claim_id, v_address, v_contractor_user
    FROM public.quotes q
    JOIN public.claims c ON c.id = q.claim_id
    JOIN public.contractors k ON k.id = q.contractor_id
   WHERE q.id = p_quote_id
     AND c.user_id = v_uid                      -- caller owns the claim this bid is on
     AND COALESCE(q.bid_status, 'active') <> 'cancelled';

  IF NOT FOUND OR v_contractor_user IS NULL THEN
    RETURN false;
  END IF;

  -- One notification per quote per 24 hours.
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id = v_contractor_user
       AND n.claim_id = v_claim_id
       AND n.notification_type = 'bid_renewal_requested'
       AND n.created_at > now() - interval '24 hours'
  ) THEN
    RETURN true;
  END IF;

  INSERT INTO public.notifications (user_id, claim_id, notification_type, channel, recipient, message_preview)
  VALUES (
    v_contractor_user, v_claim_id, 'bid_renewal_requested', 'dashboard', '',
    'A homeowner is requesting an updated bid on ' || COALESCE(v_address, 'their project') || '.'
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.request_bid_renewal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_bid_renewal(uuid) TO authenticated;

COMMENT ON FUNCTION public.request_bid_renewal(uuid) IS
  'gh-3049: homeowner asks an expired bidder for an updated bid. Resolves the contractor user_id server side from a quote on a claim the caller owns, inserts one dashboard bid_renewal_requested notification, returns boolean only (never the user_id). 24h dedupe per claim+contractor.';

DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'request_bid_renewal';
  IF NOT r.prosecdef THEN RAISE EXCEPTION 'gh3049: not SECURITY DEFINER'; END IF;
  IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN RAISE EXCEPTION 'gh3049: search_path %', r.proconfig; END IF;
  IF r.anon_x OR r.public_x OR NOT r.auth_x THEN RAISE EXCEPTION 'gh3049: grants wrong'; END IF;
END $$;

COMMIT;
