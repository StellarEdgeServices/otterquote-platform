-- STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3219_partner_credit_lock
-- EVIDENCE: drafted 2026-10-30 under #3219; production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): the forward file is not applied, so nothing here has anything to undo yet. The three restored function bodies are the LIVE definitions read with pg_get_functiondef that day (prosrc md5 advance_referral_registered 12f25d9ee84d4a58211e08e5c92f4c74, claims_advance_referral 99cb315ff314f88fd33ea5b5e5d61d13, referral_attribution_window 4b45984d8648af2b7027987969c6135f); the local proof run compares the md5 of the restored bodies to those values.
-- REPO COPY: none. When the set is applied, move this rollback to supabase/migrations_rollbacks/ under the forward file's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: reverts gh3219_partner_credit_lock.sql. Restores advance_referral_registered(uuid), claims_advance_referral() and
-- referral_attribution_window() to their live pre-change definitions (30 days, IMMUTABLE, no lock), drops the claims_lock_referral
-- trigger and its function, drops get_locked_referral_id(), the unique index and referrals.homeowner_user_id, and removes the
-- partner_attribution_window_days setting.
-- WARNING: dropping referrals.homeowner_user_id DESTROYS the recorded locks (who is credited to whom). If locks have been written in
-- production and the lock rule is to be withdrawn but the history kept, export (id, homeowner_user_id) first:
--   SELECT id, homeowner_user_id FROM public.referrals WHERE homeowner_user_id IS NOT NULL;
-- Rolling back also returns the window to 30 days for every referral click, including those 31-90 days old that the forward file let advance.
-- ACLs are unchanged by CREATE OR REPLACE; the restored referral_attribution_window() keeps its postgres-only ACL.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- the claims trigger first (it calls the function dropped below)
DROP TRIGGER IF EXISTS claims_lock_referral ON public.claims;
DROP FUNCTION IF EXISTS public.claims_apply_locked_referral();
DROP FUNCTION IF EXISTS public.get_locked_referral_id();

-- restore the two functions to their live pre-change bodies
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

-- restore the window to the hard-coded 30 days (IMMUTABLE, as live before the change)
CREATE OR REPLACE FUNCTION public.referral_attribution_window()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT interval '30 days' $function$;

COMMENT ON FUNCTION public.referral_attribution_window() IS
  'gh-2345: the ONE place the partner-referral attribution window lives (30 days from the partner-link click; CEO ruling gh-2062 comment 5874597169). Used by advance_referral_registered and claims_advance_referral. Internal helper: no client role may execute it.';

REVOKE ALL ON FUNCTION public.referral_attribution_window() FROM PUBLIC, anon, authenticated, service_role;

-- the setting, the index and the column (the column drop deletes the recorded locks, see the WARNING above)
DELETE FROM public.platform_settings WHERE key = 'partner_attribution_window_days';
DROP INDEX IF EXISTS public.referrals_homeowner_user_id_locked_key;
ALTER TABLE public.referrals DROP COLUMN IF EXISTS homeowner_user_id;

COMMIT;
