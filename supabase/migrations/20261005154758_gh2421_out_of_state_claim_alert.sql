-- gh-1438 reconciliation (cto61, 2026-10-06T19:47:53Z): renamed from 20261003130000_gh2421_out_of_state_claim_alert.sql to the REAL applied ledger version.
-- Ledger row: supabase_migrations.schema_migrations version=20261005154758 (SELECT-only read 2026-10-06). Content check: live prosrc md5 afbef471 and 5a7e84aa = file bodies; triggers and column present.
-- Executable SQL body unchanged; only the filename version prefix and this banner changed.
-- gh-2421 (D-344), PR B: alert Dustin when a claim has a property_state that
-- is not IN and not on the blocked list (FL, LA, TX by default). Tier 3B
-- (new trigger that drives an email-sending Edge Function). Requirement,
-- verbatim from the issue: "Alert Dustin the moment a claim is created with
-- property_state not IN and not blocked: state, trade, claim id."
--
-- DEPLOY ORDER: deploy the notify-admin-new-homeowner Edge Function FIRST,
-- then apply this migration. The trigger posts event_type=out_of_state_claim;
-- an Edge Function that predates this change answers 400 to it and the alert
-- for that claim would be missed until its next property_state write.
--
-- KEY FINDING (why a trigger on UPDATE as well as INSERT): property_state is
-- written by trade-selector.html:1419 / react-app/app/trade-selector/page.tsx:954
-- as `profile?.address_state || null` / `parsedAddress.state`, on BOTH the
-- insert branch and the "existing claim" UPDATE branch (trade-selector.html
-- :1446-1451), and it can be NULL at insert. So the insert-time claim_created
-- email can miss it. One trigger covers both: AFTER INSERT OR UPDATE OF
-- property_state.
--
-- Exactly once: claims.out_of_state_alerted_at (new, nullable) is stamped by
-- the Edge Function with an atomic UPDATE ... WHERE out_of_state_alerted_at IS
-- NULL ... RETURNING (gh-1994 alerted_at pattern). The trigger WHEN clause and
-- the function also skip already-stamped rows to avoid a pointless network
-- call, but the Edge Function's stamp is the authoritative dedupe. A later
-- change of state on an already-alerted claim does not alert again.
--
-- Eligibility is decided in the Edge Function (authoritative): not is_test,
-- profile not test/excluded, state not IN, state not in
-- platform_settings.homeowner_blocked_states (default FL/LA/TX if the row is
-- missing). This trigger only skips what is cheap and certain (is_test, IN,
-- NULL/blank state), so it does not duplicate the blocked list and cannot
-- drift from it.
--
-- Non-fatal: pg_net failures, a missing vault secret, anything: RAISE LOG and
-- RETURN NEW. A claim write never fails because of the alert. The trigger is
-- AFTER, so it cannot alter the row either.
--
-- Mechanism mirrors trg_notify_admin_new_claim (20260914195746_gh1932) and
-- trg_notify_admin_new_router_lead (20260917010217_gh1994): SECURITY DEFINER
-- plpgsql, service-role key from vault.decrypted_secrets
-- (name='cron_service_role_key'), net.http_post with a jsonb body. The body
-- carries only the claim id; the Edge Function re-reads everything.
--
-- Suppression guard: claims is writable by its owner (trade-selector updates
-- it as the homeowner), so without a guard a client could set
-- out_of_state_alerted_at on its own row and silence its own alert (same
-- class as gh-1994 fix round 1, N2). A BEFORE INSERT OR UPDATE trigger resets
-- the column for the anon/authenticated roles; service_role, postgres and the
-- Edge Function path are untouched.
--
-- Additive: one nullable column, two functions, two triggers. No existing
-- object is altered or dropped.

BEGIN;

-- 1. Dedupe column -----------------------------------------------------------
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS out_of_state_alerted_at timestamptz;

COMMENT ON COLUMN public.claims.out_of_state_alerted_at IS
  'gh-2421 (D-344): stamped by notify-admin-new-homeowner (event_type=out_of_state_claim) when it sends the one-time out-of-state alert for this claim. An atomic UPDATE ... WHERE out_of_state_alerted_at IS NULL enforces once per claim. NULL = not alerted (or send failed and the stamp was reverted). Client roles cannot write it (guard trigger).';

-- 2. Suppression guard -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claims_guard_out_of_state_alerted_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.out_of_state_alerted_at := NULL;
    ELSE
      NEW.out_of_state_alerted_at := OLD.out_of_state_alerted_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.claims_guard_out_of_state_alerted_at() IS
  'gh-2421: BEFORE INSERT OR UPDATE guard on public.claims. Client roles (anon, authenticated) cannot set or change out_of_state_alerted_at, so a homeowner cannot suppress the out-of-state alert for their own claim. Other roles (service_role, postgres) are untouched.';

DROP TRIGGER IF EXISTS trg_claims_guard_out_of_state_alerted_at ON public.claims;

CREATE TRIGGER trg_claims_guard_out_of_state_alerted_at
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.claims_guard_out_of_state_alerted_at();

-- 3. Alert trigger function --------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_admin_out_of_state_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
  v_service_key TEXT;
BEGIN
  -- Cheap short-circuits; the Edge Function re-decides all of these.
  IF NEW.out_of_state_alerted_at IS NOT NULL OR NEW.is_test IS TRUE THEN
    RETURN NEW;
  END IF;

  IF btrim(coalesce(NEW.property_state, '')) = '' OR upper(btrim(NEW.property_state)) = 'IN' THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_out_of_state_claim: vault secret cron_service_role_key not found -- skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-homeowner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'event_type', 'out_of_state_claim',
      'record',     jsonb_build_object('id', NEW.id)
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_out_of_state_claim: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_admin_out_of_state_claim() IS
  'gh-2421 (D-344): fires via pg_net when a claim has a non-blank property_state other than IN. Calls notify-admin-new-homeowner (event_type=out_of_state_claim); the Edge Function applies the blocked list, test exclusions and the once-only stamp. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

-- 4. Alert trigger -----------------------------------------------------------
DROP TRIGGER IF EXISTS trg_notify_admin_out_of_state_claim ON public.claims;

CREATE TRIGGER trg_notify_admin_out_of_state_claim
  AFTER INSERT OR UPDATE OF property_state ON public.claims
  FOR EACH ROW
  WHEN (NEW.property_state IS NOT NULL AND NEW.out_of_state_alerted_at IS NULL AND NEW.is_test IS NOT TRUE)
  EXECUTE FUNCTION public.notify_admin_out_of_state_claim();

COMMENT ON TRIGGER trg_notify_admin_out_of_state_claim ON public.claims IS
  'gh-2421 (D-344): fires after a claim is inserted with, or has property_state set to, a non-NULL value. Calls notify_admin_out_of_state_claim().';

COMMIT;

-- Rollback: supabase/migrations_rollbacks/20261003130000_gh2421_out_of_state_claim_alert_rollback.sql
