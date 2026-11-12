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

  -- One dashboard notification per claim + contractor user per 24 hours. Scoped to channel = 'dashboard':
  -- notify-contractors writes bid_renewal_requested rows on channel 'email' (contractor renewed their bid),
  -- which must not suppress the homeowner's request.
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.user_id = v_contractor_user
       AND n.claim_id = v_claim_id
       AND n.notification_type = 'bid_renewal_requested'
       AND n.channel = 'dashboard'
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