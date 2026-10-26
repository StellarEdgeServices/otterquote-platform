-- gh-1411 / D-317 cl. 5 -- DRAFT, NOT APPLIED (Tier 3: new SECURITY DEFINER function; needs approval).
-- Lets the HOMEOWNER's bids.html learn which contractors bought the detailed measurement upgrade
-- (hover_orders.product_code = 'roof_upgrade_detailed') for the homeowner's own claim, so the bid card can
-- carry the D-317 cl. 5 mark "Bid on detailed measurements". hover_orders SELECT RLS is user_id = auth.uid(),
-- so the homeowner cannot read a contractor's purchase row directly.
-- Returns ONLY contractor ids (no amounts, no payment ids, no measurements), and ONLY for a claim the caller owns.
CREATE OR REPLACE FUNCTION public.get_claim_detailed_measurement_bidders(p_claim_id uuid)
RETURNS TABLE(contractor_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT h.requested_by_contractor_id
  FROM public.hover_orders h
  JOIN public.claims c ON c.id = h.claim_id
  WHERE h.claim_id = p_claim_id
    AND c.user_id = auth.uid()
    AND h.product_code = 'roof_upgrade_detailed'
    AND h.requested_by_contractor_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.get_claim_detailed_measurement_bidders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_claim_detailed_measurement_bidders(uuid) TO authenticated;
