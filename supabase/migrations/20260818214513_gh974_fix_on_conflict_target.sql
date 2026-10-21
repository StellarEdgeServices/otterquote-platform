-- gh974 second follow-up: ON CONFLICT (adjuster_email) referenced a
-- constraint that does not exist. The table's real unique constraint is
-- composite: adjusters_adjuster_name_adjuster_email_carrier_id_key
-- (adjuster_name, adjuster_email, carrier_id). This is a second,
-- independent pre-existing bug in the inherited function body (on top of
-- the times_seen/last_seen_at one already fixed) - the email-upsert path
-- has never once executed successfully. Fixing the ON CONFLICT target to
-- match the actual constraint so the function no longer errors.
--
-- Flagging, not solving today: with carrier_id nullable and NULL <> NULL
-- under standard uniqueness semantics, two submissions for the same
-- adjuster with no carrier_id will insert two rows rather than updating
-- one - a real semantic gap in the existing data model, pre-dating this
-- fix, out of scope for #974 (an auth hole, not a data-model redesign).

CREATE OR REPLACE FUNCTION public.upsert_adjuster_from_claim(
  p_claim_id        uuid,
  p_adjuster_name   text,
  p_adjuster_email  text,
  p_adjuster_phone  text,
  p_carrier_id      uuid DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_adjuster_id uuid;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'p_claim_id is required';
  END IF;

  IF NOT (
    EXISTS (
      SELECT 1 FROM claims
      WHERE claims.id = p_claim_id
        AND claims.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM quotes q
      JOIN contractors c ON c.id = q.contractor_id
      WHERE q.claim_id = p_claim_id
        AND c.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized: caller is not party to claim %', p_claim_id;
  END IF;

  IF p_adjuster_email IS NULL OR trim(p_adjuster_email) = '' THEN
    INSERT INTO adjusters (adjuster_name, adjuster_phone, carrier_id)
    VALUES (p_adjuster_name, p_adjuster_phone, p_carrier_id)
    RETURNING id INTO v_adjuster_id;
    RETURN v_adjuster_id;
  END IF;
  INSERT INTO adjusters (adjuster_name, adjuster_email, adjuster_phone, carrier_id, updated_at)
  VALUES (p_adjuster_name, lower(trim(p_adjuster_email)), p_adjuster_phone, p_carrier_id, now())
  ON CONFLICT (adjuster_name, adjuster_email, carrier_id) DO UPDATE SET
    adjuster_phone = COALESCE(EXCLUDED.adjuster_phone, adjusters.adjuster_phone),
    updated_at     = now()
  RETURNING id INTO v_adjuster_id;
  RETURN v_adjuster_id;
END;
$function$;
