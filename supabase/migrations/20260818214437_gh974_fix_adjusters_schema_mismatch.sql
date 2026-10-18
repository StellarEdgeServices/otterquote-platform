-- gh974 follow-up: found while live-verifying the companion-pair fix.
-- The function body (copied verbatim from the pre-existing implementation,
-- per the approved package) references adjusters.times_seen and
-- adjusters.last_seen_at, neither of which exists on the live table
-- (actual columns: id, adjuster_name, adjuster_email, adjuster_phone,
-- carrier_id, region, notes, created_at, updated_at). This means the
-- email-provided upsert path has been failing with 42703 since the
-- function was created - independent of today's auth fix, and silently
-- swallowed by dashboard.html's try/catch (non-critical fire-and-forget).
-- adjusters having 0 rows today is consistent with this: the insert path
-- never once succeeded. Fixing so the companion-pair change actually works
-- end-to-end, not just closes the auth hole on a function that still 500s.

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
  ON CONFLICT (adjuster_email) DO UPDATE SET
    adjuster_name  = COALESCE(EXCLUDED.adjuster_name, adjusters.adjuster_name),
    adjuster_phone = COALESCE(EXCLUDED.adjuster_phone, adjusters.adjuster_phone),
    carrier_id     = COALESCE(EXCLUDED.carrier_id, adjusters.carrier_id),
    updated_at     = now()
  RETURNING id INTO v_adjuster_id;
  RETURN v_adjuster_id;
END;
$function$;
