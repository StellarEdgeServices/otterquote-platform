-- gh-1932: admin push alert on real homeowner signup + real claim created.
-- Filed by CEO RUN 42 (claim ceo-2026-09-14T18:27:56Z); Dustin's GO recorded
-- verbatim on issue #1932 ("I want to make sure that I know when someone is
-- in the system... can you handle it now?"). Tier 3B, size S.
--
-- Additive only: two new trigger functions + two new AFTER INSERT triggers.
-- No existing table, column, function or trigger is altered or dropped.
--
-- Mechanism copied from the only existing trigger->Edge-Function wiring in
-- this repo (notify_admin_new_contractor / trg_notify_admin_new_contractor,
-- supabase/migrations/20260602155343_v85_notify_admin_new_contractor.sql,
-- moved onto Vault by 20260817222018_gh752_move_notify_functions_to_vault.sql):
-- SECURITY DEFINER plpgsql trigger function, service-role key resolved from
-- vault.decrypted_secrets (name='cron_service_role_key' — the same secret
-- 10+ live cron jobs and apply_referral_commission() already use), calling
-- net.http_post() with the key as a Bearer token. pg_net failures are
-- caught and RAISE LOGged, never raised — the homeowner/claim insert must
-- never fail because the notify call failed.
--
-- DEVIATION FROM THE COPIED PATTERN (deliberate, documented): the live
-- notify_admin_new_contractor() body passes
-- `jsonb_build_object(...)::text::bytea` to net.http_post's `body` param.
-- Live inspection this session (pg_get_functiondef, both the current
-- function and its 20260817222018_gh752 repo record) shows this cast has no
-- bytea<-jsonb cast against the installed net.http_post(url text, body
-- jsonb, ...) signature, so every call throws 42883 and is silently
-- swallowed by the EXCEPTION handler -- confirmed by notifications table
-- query this session: notification_type='admin_new_contractor' has ZERO
-- rows despite contractors having 13 rows and pending_approval signups
-- happening regularly. The already-corrected sibling call in this same repo
-- (apply_referral_commission()'s notify-payout-pending call, same
-- migration file) passes the jsonb value to `body` directly, with no cast --
-- that is the pattern used below. Flagging the contractor bug as a
-- fast-follow for whoever owns that function; NOT fixed by this migration
-- (out of scope for gh-1932, no write authority over that function here).
--
-- Role value confirmed live: public.profiles.role is text NOT NULL, live
-- values are exactly {'contractor','homeowner'} (30 homeowner rows / 15
-- contractor rows, 2026-09-14). No FK to a lookup table -- 'homeowner' is
-- the correct literal.

BEGIN;

-- 1 of 2: homeowner signup (profiles insert, role = 'homeowner')
CREATE OR REPLACE FUNCTION public.notify_admin_new_homeowner_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_service_key TEXT;
BEGIN
  IF NEW.role IS DISTINCT FROM 'homeowner' THEN
    RETURN NEW;
  END IF;

  -- gh-1932 exclusion list (broader than notify_admin_new_contractor's):
  -- is_test, %test%, @otterquote.com, @tryotterquote.com,
  -- @stellaredgeservices.com, %stohler%. The Edge Function re-checks these
  -- independently -- this is belt-and-suspenders to avoid a pg_net call at
  -- all for the common test-row case.
  IF NEW.is_test IS TRUE
     OR NEW.email ILIKE '%test%'
     OR NEW.email ILIKE '%@otterquote.com'
     OR NEW.email ILIKE '%@tryotterquote.com'
     OR NEW.email ILIKE '%@stellaredgeservices.com'
     OR NEW.email ILIKE '%stohler%' THEN
    RAISE LOG 'notify_admin_new_homeowner_signup: skipping test/excluded account id=% email=%', NEW.id, NEW.email;
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_homeowner_signup: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-homeowner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'event_type', 'homeowner_signup',
      'record',     to_jsonb(NEW)
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_homeowner_signup: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_admin_new_homeowner_signup() IS
'gh-1932: fires via pg_net on profiles insert where role=''homeowner''. Calls the notify-admin-new-homeowner Edge Function to alert Dustin. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

DROP TRIGGER IF EXISTS trg_notify_admin_new_homeowner ON public.profiles;

CREATE TRIGGER trg_notify_admin_new_homeowner
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.role = 'homeowner')
  EXECUTE FUNCTION public.notify_admin_new_homeowner_signup();

COMMENT ON TRIGGER trg_notify_admin_new_homeowner ON public.profiles IS
'gh-1932: fires after INSERT of a homeowner profile. Calls notify_admin_new_homeowner_signup() to alert Dustin.';

-- 2 of 2: claim created (claims insert)
CREATE OR REPLACE FUNCTION public.notify_admin_new_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_service_key TEXT;
BEGIN
  -- claims carries its own is_test flag; the email-based exclusion list
  -- (%test%/@otterquote.com/etc.) needs the owning profile's email, which
  -- this table doesn't have a column for -- the Edge Function resolves
  -- profiles.email + profiles.is_test via record.user_id and applies the
  -- full gh-1932 exclusion list there.
  IF NEW.is_test IS TRUE THEN
    RAISE LOG 'notify_admin_new_claim: skipping is_test claim id=%', NEW.id;
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_claim: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-homeowner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'event_type', 'claim_created',
      'record',     to_jsonb(NEW)
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_claim: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_admin_new_claim() IS
'gh-1932: fires via pg_net on claims insert. Calls the notify-admin-new-homeowner Edge Function (event_type=claim_created) to alert Dustin. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

DROP TRIGGER IF EXISTS trg_notify_admin_new_claim ON public.claims;

CREATE TRIGGER trg_notify_admin_new_claim
  AFTER INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_new_claim();

COMMENT ON TRIGGER trg_notify_admin_new_claim ON public.claims IS
'gh-1932: fires after INSERT on claims. Calls notify_admin_new_claim() to alert Dustin a new claim was created.';

COMMIT;

-- =============================================================================
-- ROLLBACK (gh-1932) — run as a single transaction to revert this migration.
-- Dropping the triggers is sufficient; the Edge Function and trigger
-- functions can be left in place inert, but are dropped here too for a
-- fully clean revert. Nothing else in the schema is touched.
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_notify_admin_new_homeowner ON public.profiles;
-- DROP TRIGGER IF EXISTS trg_notify_admin_new_claim ON public.claims;
-- DROP FUNCTION IF EXISTS public.notify_admin_new_homeowner_signup();
-- DROP FUNCTION IF EXISTS public.notify_admin_new_claim();
-- COMMIT;
