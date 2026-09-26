-- gh-2042: the /start front door hard-gated on a 10-digit US phone number
-- before delivering any value. Dustin's ruling, 2026-09-20, verbatim:
-- "Make phone optional". The client gate is removed in start.html and
-- js/router-discovery.js; this is the server half.
--
-- update_lead_contact() is the Step 1 RESUBMIT path (back-button return to
-- the contact screen, then Continue again). It RAISED on a NULL or empty
-- phone, so without this migration the client change would ship a front door
-- that accepts a blank phone on first submit and throws on resubmit.
--
-- What changes: phone is validated ONLY when a non-blank value is supplied.
-- NULL and '' are accepted and stored as NULL. Name and email validation are
-- untouched -- removing one gate must not remove the others.
BEGIN;

CREATE OR REPLACE FUNCTION public.update_lead_contact(p_lead_id uuid, p_name text, p_email text, p_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows int;
  v_phone text;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'update_lead_contact: name required';
  END IF;
  IF char_length(p_name) > 200 THEN
    RAISE EXCEPTION 'update_lead_contact: name too long';
  END IF;
  IF p_email IS NULL OR p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'update_lead_contact: invalid email';
  END IF;
  IF char_length(p_email) > 320 THEN
    RAISE EXCEPTION 'update_lead_contact: email too long';
  END IF;

  -- gh-2042: optional phone. Blank -> NULL, no exception. A SUPPLIED phone is
  -- validated exactly as before, so a typo is still rejected rather than stored.
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  IF v_phone IS NOT NULL THEN
    IF char_length(v_phone) > 20 THEN
      RAISE EXCEPTION 'update_lead_contact: phone too long';
    END IF;
    IF v_phone !~ '^[2-9]\d{2}[2-9]\d{6}$' OR v_phone ~ '^(\d)\1{9}$' THEN
      RAISE EXCEPTION 'update_lead_contact: invalid phone';
    END IF;
  END IF;

  UPDATE public.leads
     SET name  = p_name,
         email = p_email,
         phone = v_phone
   WHERE id = p_lead_id
     AND created_at > now() - interval '30 minutes'
     AND prefill_used_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

COMMIT;
