-- Rollback for: supabase/migrations/20260929180000_gh2345_referral_rpc_age_check.sql
-- GitHub: #2345. Tier 3B. Restores advance_referral_registered(uuid) and claims_advance_referral() to their
-- live pre-change definitions (copied from pg_get_functiondef on production yeszghaspzwwstvsrioa, 2026-09-29),
-- then drops the helper referral_attribution_window(). No data is touched. ACLs are unchanged (CREATE OR REPLACE keeps them).
-- Effect: the server-side 30-day check goes away; the client (js/cookie-storage.js) is again the only enforcement.

BEGIN;

CREATE OR REPLACE FUNCTION public.advance_referral_registered(p_referral_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text;
BEGIN
  IF p_referral_id IS NULL THEN
    RETURN false;
  END IF;

  v_email := NULLIF(auth.jwt() ->> 'email', '');

  UPDATE referrals
     SET status          = 'registered',
         homeowner_email = COALESCE(v_email, homeowner_email)
   WHERE id = p_referral_id
     AND status = 'clicked';

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claims_advance_referral()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_updated      INT;
  v_service_role_key  TEXT;
BEGIN
  BEGIN
    UPDATE referrals
       SET status = 'claim_submitted'
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered');
    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_rows_updated := 0;
    NULL;  -- never break the claim write
  END;

  -- gh-916 AC2: progressive partner-status notify, catch-up mode. Only fires
  -- when this trigger actually advanced the referral, to avoid firing on
  -- every unrelated claims write with the same referral_id. Independent
  -- BEGIN/EXCEPTION block — a failure here must never break the claims write
  -- this trigger exists to protect.
  IF v_rows_updated > 0 THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_role_key
        FROM vault.decrypted_secrets
       WHERE name = 'cron_service_role_key';

      IF v_service_role_key IS NULL THEN
        RAISE LOG 'claims_advance_referral: vault secret cron_service_role_key not found — skipping send-partner-status-email for referral_id=%', NEW.referral_id;
      ELSE
        PERFORM net.http_post(
          url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
          ),
          body    := jsonb_build_object('referral_id', NEW.referral_id)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'claims_advance_referral: pg_net call to send-partner-status-email failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
        NEW.referral_id, SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.referral_attribution_window();

COMMIT;
