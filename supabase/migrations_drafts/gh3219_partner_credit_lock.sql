-- STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3219_partner_credit_lock (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3219 (P18). Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): referrals has no
--   homeowner_user_id column; referral_attribution_window() is IMMUTABLE, body `SELECT interval '30 days'`, ACL postgres only;
--   advance_referral_registered(uuid) (prosrc md5 12f25d9e...), claims_advance_referral() (md5 99cb315f...) read with pg_get_functiondef;
--   platform_settings has 10 rows and no partner_attribution_window_days key; claims has 18 triggers, none locks a referral;
--   1 user has a claim with referral_id set, 0 users have claims with two different referral_ids. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3219_partner_credit_lock
-- GitHub: #3219 (PROJECT P18 - Influencer partner page + partner dashboard). Money/attribution path: Tier 3B (R-097), changes how
--   partner money is credited. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after the R-097 notice. NOT APPLIED.
-- Rollback: supabase/migrations_drafts/gh3219_partner_credit_lock_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh3219_partner_credit_lock_pre-flight.md
-- Proof: supabase/tests/gh3219_partner_credit_lock_proof.sql (one batch, forced RAISE EXCEPTION rollback)
--
-- Rule (Dustin, one plan for every partner, realtor or influencer): a 90-day window from the partner-link click; the LAST partner link
-- clicked before the homeowner creates an account wins; the credit LOCKS at account creation, so a later click on another partner's link
-- cannot take it.
--
-- What this file does
--   1. referrals.homeowner_user_id uuid NULL + a unique partial index: each user has at most one locked referral.
--   2. referral_attribution_window() reads platform_settings.partner_attribution_window_days (seeded 90, fallback 90) and is STABLE
--      (it reads a table, so IMMUTABLE was wrong the moment the value could change).
--   3. advance_referral_registered(uuid) records the signed-in user on the referral it advances, only when that user has no LIVE locked
--      referral yet; a user with a live lock gets false and the other referral is untouched.
--   4. get_locked_referral_id() (new, authenticated only) lets the browser ask which referral is LIVE-locked to the caller.
--   5. claims_apply_locked_referral() + trigger claims_lock_referral (new, BEFORE INSERT): a claim of a user with a live locked referral
--      is stamped with the locked referral_id and its referral_agent_id, whatever the browser sent.
--   6. claims_advance_referral() advances only the user's own live locked referral (or an unlocked one, which it then locks to the claim's user).
-- LAPSE (Ben's ruling on #3219, comment 6523708028): a lock lapses with the window. It is live while its credited click
--   (referrals.created_at) is not older than referral_attribution_window(). Past that it blocks nobody: if the claim carries a NEWER click
--   that is itself inside the window, that partner is credited and the lock MOVES to that referral (the lapsed referral's
--   homeowner_user_id is cleared, so the one-lock-per-user index holds); if it does not, nobody is credited (the claim's referral_id is
--   NULLed). The rejected alternative was a lock that holds forever but credits nothing.
-- referrals.homeowner_user_id is NOT added to any grant or allow-list here, and must stay off the partner column allow-list that PR #3225
--   (#3217) introduces: whichever of the two merges second must keep it excluded. This file contains no GRANT/REVOKE on referrals.
-- Signatures, return types, SECURITY DEFINER, search_path and ACLs of the three existing functions are unchanged (CREATE OR REPLACE keeps them).
-- apply_referral_commission() is NOT edited, but it calls referral_attribution_window(), so its commission window follows the setting too.
-- Idempotent. No existing row is changed except the one platform_settings insert; there is no backfill of homeowner_user_id.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. column and index -------------------------------------------------------------------------------------------------------------
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS homeowner_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.referrals.homeowner_user_id IS
  'gh-3219 (P18): the homeowner account this referral is LOCKED to. Set by advance_referral_registered (or, for an unlocked referral, by claims_advance_referral) the first time that user is credited; at most one locked referral per user (unique partial index). NULL = not locked.';

CREATE UNIQUE INDEX IF NOT EXISTS referrals_homeowner_user_id_locked_key
  ON public.referrals (homeowner_user_id)
  WHERE homeowner_user_id IS NOT NULL;

-- 2. the window: one place, read from platform_settings ------------------------------------------------------------------------------
INSERT INTO public.platform_settings (key, value)
VALUES ('partner_attribution_window_days', to_jsonb(90))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.referral_attribution_window()
 RETURNS interval
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT make_interval(days => COALESCE(
    (SELECT CASE WHEN (s.value #>> '{}') ~ '^[0-9]{1,4}$'
                 THEN CASE WHEN (s.value #>> '{}')::int BETWEEN 1 AND 3650
                           THEN (s.value #>> '{}')::int END
            END
       FROM public.platform_settings s
      WHERE s.key = 'partner_attribution_window_days'),
    90))
$function$;

COMMENT ON FUNCTION public.referral_attribution_window() IS
  'gh-3219 (P18): the ONE place the partner-referral attribution window lives: platform_settings.partner_attribution_window_days (whole days, 1-3650), 90 when the key is absent or not such a number. Counted from the partner-link click. Used by advance_referral_registered, claims_advance_referral and apply_referral_commission. Internal helper: no client role may execute it. (Replaces the gh-2345 hard-coded IMMUTABLE 30 days.)';

REVOKE ALL ON FUNCTION public.referral_attribution_window() FROM PUBLIC, anon, authenticated, service_role;

-- 3. advance_referral_registered: record the lock ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_referral_registered(p_referral_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text;
  v_uid   uuid;
BEGIN
  IF p_referral_id IS NULL THEN
    RETURN false;
  END IF;

  v_email := NULLIF(auth.jwt() ->> 'email', '');
  v_uid   := auth.uid();

  -- gh-3219 (P18): the credit locks at account creation. A user who already has a LIVE locked
  -- referral (its click is inside the window) keeps it: a later click on another partner's link
  -- advances nothing and locks nothing (returns false, the other referral is untouched).
  -- A lapsed lock (click older than the window) blocks nobody (Ben's ruling on #3219).
  IF v_uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM referrals
                  WHERE homeowner_user_id = v_uid
                    AND id <> p_referral_id
                    AND created_at >= now() - public.referral_attribution_window()) THEN
    RAISE LOG 'advance_referral_registered: gh-3219 credit already locked for this user - no-op for referral_id=%', p_referral_id;
    RETURN false;
  END IF;

  -- gh-2345: server-side attribution window. The click time is
  -- referrals.created_at (the row is inserted by track_referral_click at the
  -- click). A click older than the window, or with no click time, is a no-op
  -- (returns false, row untouched). NULL created_at makes the comparison
  -- NULL, so an undated row never advances (CEO ruling 5880667348).
  -- gh-3219: the same UPDATE records the user on the referral; a referral
  -- already locked to a different user is not advanced.
  BEGIN
    -- gh-3219 lapse: this click will advance and take the lock, so release the user's lapsed lock first
    -- (the guard above returned for a live lock, so any other lock left here is lapsed). One subtransaction:
    -- if the advance below fails, the release is undone with it.
    IF v_uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM referrals
                    WHERE id = p_referral_id
                      AND status = 'clicked'
                      AND created_at >= now() - public.referral_attribution_window()
                      AND (homeowner_user_id IS NULL OR homeowner_user_id = v_uid)) THEN
      UPDATE referrals SET homeowner_user_id = NULL
       WHERE homeowner_user_id = v_uid AND id <> p_referral_id;
    END IF;

    UPDATE referrals
       SET status            = 'registered',
           homeowner_email   = COALESCE(v_email, homeowner_email),
           homeowner_user_id = COALESCE(homeowner_user_id, v_uid)
     WHERE id = p_referral_id
       AND status = 'clicked'
       AND created_at >= now() - public.referral_attribution_window()
       AND (homeowner_user_id IS NULL OR homeowner_user_id = v_uid);
  EXCEPTION WHEN unique_violation THEN
    -- two sign-ins of the same user raced for two different referrals; the first one won
    RAISE LOG 'advance_referral_registered: gh-3219 lost the lock race for referral_id=%', p_referral_id;
    RETURN false;
  END;

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

-- 4. get_locked_referral_id: the browser's view of the lock --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_locked_referral_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id FROM public.referrals r
   WHERE r.homeowner_user_id = auth.uid()
     AND r.created_at >= now() - public.referral_attribution_window()
   LIMIT 1
$function$;

COMMENT ON FUNCTION public.get_locked_referral_id() IS
  'gh-3219 (P18): the referral id LIVE-locked to the calling user (referrals.homeowner_user_id = auth.uid() and its click inside the attribution window; a lapsed lock returns NULL), or NULL. Returns only the caller''s own row id.';

REVOKE ALL ON FUNCTION public.get_locked_referral_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_locked_referral_id() TO authenticated, service_role;

-- 5. claim stamping: the locked referral wins over whatever the browser sent ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claims_apply_locked_referral()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ref_id  uuid;
  v_agent   uuid;
  v_clicked timestamptz;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.id, r.referral_agent_id, r.created_at INTO v_ref_id, v_agent, v_clicked
    FROM public.referrals r
   WHERE r.homeowner_user_id = NEW.user_id
   LIMIT 1;

  IF v_ref_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_clicked >= now() - public.referral_attribution_window() THEN   -- LAPSE-CHECK: the lock is live
    IF NEW.referral_id IS DISTINCT FROM v_ref_id THEN
      RAISE LOG 'claims_apply_locked_referral: gh-3219 locked referral % replaces sent referral % for user_id=%', v_ref_id, NEW.referral_id, NEW.user_id;
    END IF;
    NEW.referral_id       := v_ref_id;
    NEW.referral_agent_id := v_agent;
    RETURN NEW;
  END IF;

  -- The lock has lapsed (its click is older than the window, or undated): it blocks nobody (Ben's ruling on #3219).
  IF NEW.referral_id IS NOT NULL
     AND NEW.referral_id <> v_ref_id
     AND EXISTS (SELECT 1 FROM public.referrals n
                  WHERE n.id = NEW.referral_id
                    AND n.created_at >= now() - public.referral_attribution_window()
                    AND n.homeowner_user_id IS NULL) THEN
    -- A newer click inside the window is on the claim: that partner is credited and the lock moves to it.
    -- Clear the lapsed lock now (one lock per user); claims_advance_referral (AFTER INSERT) advances the new
    -- referral and records the lock on it.
    UPDATE public.referrals SET homeowner_user_id = NULL WHERE id = v_ref_id;
    RAISE LOG 'claims_apply_locked_referral: gh-3219 lock on % lapsed; lock moves to referral % for user_id=%', v_ref_id, NEW.referral_id, NEW.user_id;
    RETURN NEW;
  END IF;

  -- No newer click inside the window: nobody is credited.
  IF NEW.referral_agent_id IS NOT DISTINCT FROM v_agent THEN
    NEW.referral_agent_id := NULL;
  END IF;
  NEW.referral_id := NULL;
  RAISE LOG 'claims_apply_locked_referral: gh-3219 lock on % lapsed and no newer click inside the window; no partner credited for user_id=%', v_ref_id, NEW.user_id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.claims_apply_locked_referral() FROM PUBLIC, anon, authenticated;

-- fires after claims_guard_* (alphabetical) and before trg_claims_advance_referral (AFTER)
-- CREATE OR REPLACE TRIGGER (PG14+) is idempotent and takes SHARE ROW EXCLUSIVE, not the ACCESS EXCLUSIVE of DROP TRIGGER (see gh2997).
CREATE OR REPLACE TRIGGER claims_lock_referral
  BEFORE INSERT ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_apply_locked_referral();

-- 6. claims_advance_referral: only the user's own locked referral advances ----------------------------------------------------------
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
    -- gh-3219 (P18): a referral locked to someone else, or any referral when this
    -- claim's user has a LIVE lock on a different one, is left untouched; an unlocked
    -- referral that advances is locked to the claim's user. A lapsed lock of this user
    -- (click older than the window) blocks nobody and is released when a newer
    -- in-window referral takes the lock (Ben's ruling on #3219).
    IF NEW.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM referrals
                    WHERE id = NEW.referral_id
                      AND status IN ('clicked', 'registered')
                      AND created_at >= now() - public.referral_attribution_window()
                      AND (homeowner_user_id IS NULL OR homeowner_user_id = NEW.user_id)) THEN
      UPDATE referrals SET homeowner_user_id = NULL
       WHERE homeowner_user_id = NEW.user_id
         AND id <> NEW.referral_id
         AND created_at < now() - public.referral_attribution_window();
    END IF;

    UPDATE referrals
       SET status            = 'claim_submitted',
           homeowner_user_id = COALESCE(homeowner_user_id, NEW.user_id)
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered')
       AND created_at >= now() - public.referral_attribution_window()
       AND (homeowner_user_id IS NULL OR homeowner_user_id = NEW.user_id)
       AND NOT EXISTS (SELECT 1 FROM referrals l
                        WHERE l.homeowner_user_id = NEW.user_id
                          AND l.id <> NEW.referral_id
                          AND l.created_at >= now() - public.referral_attribution_window());
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
