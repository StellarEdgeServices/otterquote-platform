-- Migration: 20260929180000_gh2345_referral_rpc_age_check
-- GitHub: #2345 (Refs #2062, PR #2321). Money/attribution path (D-301).
-- Tier: 3B (recreates two live SECURITY DEFINER functions on a money path). NOT APPLIED. Do not apply, merge or deploy without R-097 notice.
-- Rollback: supabase/migrations_rollbacks/20260929180000_gh2345_referral_rpc_age_check_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/20260929180000_gh2345_referral_rpc_age_check_pre-flight.md
-- Proof: supabase/tests/gh2345_referral_age_check_proof.sql (BEGIN ... ROLLBACK only)
--
-- Summary: advance_referral_registered(uuid) and claims_advance_referral() (trigger fn)
-- refuse to advance a referral whose click time (referrals.created_at) is older than 30 days
-- or is NULL. The window lives in one new internal helper, referral_attribution_window().
-- Signatures, return types, SECURITY DEFINER, search_path and ACLs of the two existing functions
-- are unchanged (CREATE OR REPLACE keeps the ACL; bodies copied from pg_get_functiondef on
-- production yeszghaspzwwstvsrioa, 2026-09-29, with only the age predicate added).
-- No-op signal: advance_referral_registered returns false (its type is fixed by its signature)
-- and writes a RAISE LOG line naming the reason; the trigger leaves the row and sends no email.
-- Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.referral_attribution_window()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT interval '30 days' $$;

COMMENT ON FUNCTION public.referral_attribution_window() IS
  'gh-2345: the ONE place the partner-referral attribution window lives (30 days from the partner-link click; CEO ruling gh-2062 comment 5874597169). Used by advance_referral_registered and claims_advance_referral. Internal helper: no client role may execute it.';

REVOKE ALL ON FUNCTION public.referral_attribution_window() FROM PUBLIC, anon, authenticated, service_role;

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

  -- gh-2345: server-side attribution window. The click time is
  -- referrals.created_at (the row is inserted by track_referral_click at the
  -- click). A click older than the window, or with no click time, is a no-op
  -- (returns false, row untouched). NULL created_at makes the comparison
  -- NULL, so an undated row never advances (CEO ruling 5880667348).
  UPDATE referrals
     SET status          = 'registered',
         homeowner_email = COALESCE(v_email, homeowner_email)
   WHERE id = p_referral_id
     AND status = 'clicked'
     AND created_at >= now() - public.referral_attribution_window();

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM referrals
                WHERE id = p_referral_id
                  AND status = 'clicked'
                  AND (created_at IS NULL
                       OR created_at < now() - public.referral_attribution_window())) THEN
      RAISE LOG 'advance_referral_registered: gh-2345 attribution window closed (expired or undated click) - no-op for referral_id=%', p_referral_id;
    END IF;
    RETURN false;
  END IF;

  RETURN true;
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
    -- gh-2345: only advance inside the attribution window (see
    -- advance_referral_registered). An expired/undated referral is left
    -- untouched; v_rows_updated = 0 so no partner-status email fires either.
    UPDATE referrals
       SET status = 'claim_submitted'
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered')
       AND created_at >= now() - public.referral_attribution_window();
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

COMMIT;
