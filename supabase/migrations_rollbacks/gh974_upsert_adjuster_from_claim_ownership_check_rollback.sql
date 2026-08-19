-- Rollback for: 20260818214531_gh974_upsert_adjuster_from_claim_ownership_check.sql
-- GitHub: #974
-- WARNING: restores the PRE-FIX vulnerable behavior - no claim_id, no
-- ownership check, anon EXECUTE, AND the two schema-mismatch bugs this PR
-- also fixed (times_seen/last_seen_at, wrong ON CONFLICT target) - i.e.
-- the email-upsert path will go back to failing on every call, not just
-- become unauthenticated-writable again. Re-apply the fix ASAP after
-- rollback. If rolling back, also revert dashboard.html's p_claim_id line
-- in the same deploy (companion pair, same as forward).

DROP FUNCTION IF EXISTS public.upsert_adjuster_from_claim(uuid, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.upsert_adjuster_from_claim(p_adjuster_name text, p_adjuster_email text, p_adjuster_phone text, p_carrier_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_adjuster_id uuid;
BEGIN
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

GRANT EXECUTE ON FUNCTION public.upsert_adjuster_from_claim(text, text, text, uuid) TO anon, authenticated;
