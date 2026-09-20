-- ROLLBACK for 20260920160133_gh2042_update_lead_contact_optional_phone.sql
-- Restores the pre-gh-2042 body verbatim: phone REQUIRED and validated.
-- NOT APPLIED. Documentation/safety only. Applying this while the client
-- change is live will make the Step 1 RESUBMIT path throw for any visitor
-- who left the phone blank -- revert the client half first.
BEGIN;
CREATE OR REPLACE FUNCTION public.update_lead_contact(p_lead_id uuid, p_name text, p_email text, p_phone text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows int;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'update_lead_contact: name required'; END IF;
  IF char_length(p_name) > 200 THEN RAISE EXCEPTION 'update_lead_contact: name too long'; END IF;
  IF p_email IS NULL OR p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN RAISE EXCEPTION 'update_lead_contact: invalid email'; END IF;
  IF char_length(p_email) > 320 THEN RAISE EXCEPTION 'update_lead_contact: email too long'; END IF;
  IF p_phone IS NULL OR p_phone !~ '^[2-9]\d{2}[2-9]\d{6}$' OR p_phone ~ '^(\d)\1{9}$' THEN RAISE EXCEPTION 'update_lead_contact: invalid phone'; END IF;
  IF char_length(p_phone) > 20 THEN RAISE EXCEPTION 'update_lead_contact: phone too long'; END IF;
  UPDATE public.leads SET name = p_name, email = p_email, phone = p_phone
   WHERE id = p_lead_id AND created_at > now() - interval '30 minutes' AND prefill_used_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;
COMMIT;
