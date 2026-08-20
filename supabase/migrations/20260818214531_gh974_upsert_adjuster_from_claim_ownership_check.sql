-- gh-974: upsert_adjuster_from_claim() ownership check
-- D-182 approved by Dustin 2026-08-18 ("APPROVE ALL 7"), binding condition:
-- ships in the same deploy as the dashboard.html:2730 companion app-code
-- change (this PR includes both).
--
-- Adds a required p_claim_id leading parameter plus an ownership check
-- (caller must be the homeowner on the claim, or a contractor with a quote
-- on it) before any adjuster write. REVOKEs anon EXECUTE (no anon call site
-- exists) and grants authenticated only.
--
-- Consolidates two additional bugs found live while verifying the approved
-- package (both pre-existing, independent of the auth fix, and previously
-- silently swallowed by dashboard.html's try/catch "non-critical" wrapper):
--   1. The inherited function body referenced adjusters.times_seen and
--      adjusters.last_seen_at, neither of which exists on the live table.
--   2. `ON CONFLICT (adjuster_email)` referenced a constraint that doesn't
--      exist - the table's real unique constraint is composite:
--      adjusters_adjuster_name_adjuster_email_carrier_id_key
--      (adjuster_name, adjuster_email, carrier_id).
-- Net effect: the email-provided upsert path had never once executed
-- successfully (consistent with adjusters holding 0 rows at investigation
-- time). This migration fixes both so the approved auth fix actually ships
-- a working feature, not just a closed hole on a function that still 500s.
--
-- Flagged, not solved here (pre-existing data-model gap, out of scope for
-- an auth-hole fix): carrier_id is nullable and NULL <> NULL under standard
-- uniqueness semantics, so two submissions for the same adjuster with no
-- carrier_id will insert two rows rather than updating one.
--
-- Live-verified (rolled-back transactions, zero data changed):
--   anon EXECUTE -> structurally absent (revoked)
--   authenticated, claim not theirs -> 'not_authorized: caller is not
--     party to claim ...'
--   authenticated, own claim -> succeeds, returns a real adjuster id

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
  INSERT INTO adjusters (adjuster_name, adjuster_email, adjuster_phone, carrier_id, updated_at)
  VALUES (p_adjuster_name, lower(trim(p_adjuster_email)), p_adjuster_phone, p_carrier_id, now())
  ON CONFLICT (adjuster_name, adjuster_email, carrier_id) DO UPDATE SET
    adjuster_phone = COALESCE(EXCLUDED.adjuster_phone, adjusters.adjuster_phone),
    updated_at     = now()
  RETURNING id INTO v_adjuster_id;
  RETURN v_adjuster_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(uuid, text, text, text, uuid) TO authenticated;
