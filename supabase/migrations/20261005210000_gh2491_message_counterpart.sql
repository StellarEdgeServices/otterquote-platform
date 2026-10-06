-- gh-2491: messaging shows "--" for the other party because profiles / contractors
-- RLS (correctly) hides the counterpart's row. This adds ONE narrow SECURITY DEFINER
-- function that returns only a display label for the other party on a claim, and
-- only to a party to that claim. profiles and contractors RLS are NOT touched.
--
-- Rulings (issue #2491):
--   5969703283 (CTO RUN 57): do not widen profiles/contractors SELECT; add
--     get_message_counterpart(claim_id); EXECUTE to authenticated only.
--   5972779494 (CTO RUN 58, AMENDED, supersedes the contractor half): a contractor
--     sees the homeowner as the literal "the homeowner" until the platform fee is
--     collected (Contractor Agreement 6.2 / D-277; Ben on #2304, 5972464230). The
--     homeowner's view of the contractor is the contractor's business name.
--     "Whatever RLS-safe source feeds the label must not return the homeowner's name
--     columns to a contractor before fee collection -- hiding it in the client is not
--     enough." This function is that source: the name is selected only inside the
--     branch that has already proved (a) caller is the claim's selected contractor and
--     (b) claims.platform_fee_charged IS TRUE.
--
-- Fee state: claims.platform_fee_charged (boolean, DEFAULT false). It is written true
-- only on confirmed payment success (docusign-webhook alongside status=contract_signed,
-- and stripe-webhook on settlement), never earlier.
--
-- Returns zero rows for: anon / no session, unknown claim, a signed-in stranger, a
-- contractor with no quote on the claim, and a homeowner whose claim has no selected
-- contractor yet. Never returns email, phone, address or any column other than the label.
--
-- Rollback: supabase/migrations_rollbacks/20261005210000_gh2491_message_counterpart_rollback.sql
-- Pre-flight: 20261005210000_gh2491_message_counterpart_pre-flight.md
-- NOT APPLIED by the authoring session. Tier 3B (R-097 notice before apply).

BEGIN;

CREATE OR REPLACE FUNCTION public.get_message_counterpart(p_claim_id uuid)
RETURNS TABLE (counterpart_user_id uuid, counterpart_role text, display_label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid         uuid := auth.uid();
  v_owner       uuid;
  v_selected    uuid;
  v_fee_charged boolean;
  v_my_ctr      uuid;
  v_label       text;
BEGIN
  IF v_uid IS NULL OR p_claim_id IS NULL THEN
    RETURN;
  END IF;

  SELECT c.user_id, c.selected_contractor_id, COALESCE(c.platform_fee_charged, false)
    INTO v_owner, v_selected, v_fee_charged
    FROM public.claims c
   WHERE c.id = p_claim_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Caller is the homeowner who owns the claim: the counterpart is the selected
  -- contractor, shown by business name (public on their bid).
  IF v_owner = v_uid THEN
    IF v_selected IS NULL THEN
      RETURN;
    END IF;
    RETURN QUERY
      SELECT k.user_id,
             'contractor'::text,
             COALESCE(NULLIF(btrim(k.company_name), ''), 'your contractor')
        FROM public.contractors k
       WHERE k.id = v_selected
         AND EXISTS (
           SELECT 1 FROM public.quotes q
            WHERE q.claim_id = p_claim_id AND q.contractor_id = v_selected
         );
    RETURN;
  END IF;

  -- Caller is a contractor with a quote on this claim (the same set that
  -- contractor_messages RLS lets read the thread).
  SELECT k.id INTO v_my_ctr
    FROM public.contractors k
   WHERE k.user_id = v_uid
   LIMIT 1;

  IF v_my_ctr IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.quotes q
        WHERE q.claim_id = p_claim_id AND q.contractor_id = v_my_ctr
     ) THEN
    RETURN;  -- a stranger: nothing
  END IF;

  v_label := 'the homeowner';

  -- The ONLY path that touches the homeowner's name: this caller is the selected
  -- contractor AND the platform fee has been collected.
  IF v_selected IS NOT DISTINCT FROM v_my_ctr AND v_fee_charged THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'the homeowner')
      INTO v_label
      FROM public.profiles p
     WHERE p.id = v_owner;
    v_label := COALESCE(v_label, 'the homeowner');
  END IF;

  RETURN QUERY SELECT v_owner, 'homeowner'::text, v_label;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_message_counterpart(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_message_counterpart(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_message_counterpart(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_message_counterpart(uuid) IS
  'gh-2491: display label for the other party in a claim''s messaging thread, for a party to that claim only. Homeowner caller -> selected contractor''s company_name. Contractor caller (has a quote) -> the literal "the homeowner" until claims.platform_fee_charged is true AND caller is claims.selected_contractor_id, then profiles.full_name. Strangers/anon get zero rows. Rulings: #2491 5969703283, 5972779494 (amended); Contractor Agreement 6.2 / D-277.';

COMMIT;
