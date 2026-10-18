DROP FUNCTION IF EXISTS public.upsert_adjuster_from_claim(text, text, text, uuid);

CREATE FUNCTION public.upsert_adjuster_from_claim(
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
  INSERT INTO adjusters (adjuster_name, adjuster_email, adjuster_phone, carrier_id, times_seen, last_seen_at)
  VALUES (p_adjuster_name, lower(trim(p_adjuster_email)), p_adjuster_phone, p_carrier_id, 1, now())
  ON CONFLICT (adjuster_email) DO UPDATE SET
    adjuster_name  = COALESCE(EXCLUDED.adjuster_name, adjusters.adjuster_name),
    adjuster_phone = COALESCE(EXCLUDED.adjuster_phone, adjusters.adjuster_phone),
    carrier_id     = COALESCE(EXCLUDED.carrier_id, adjusters.carrier_id),
    times_seen     = adjusters.times_seen + 1,
    last_seen_at   = now(),
    updated_at     = now()
  RETURNING id INTO v_adjuster_id;
  RETURN v_adjuster_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) TO authenticated;
