-- gh-2154 P-3: new-partner alert to Dustin (<=60s), build phase.
-- Stacked on P-1 (7a887e65, CSPRNG signup password) and P-2 (already applied
-- to prod: referral_agents.fbclid/li_fat_id/funnel_id/app_first_signed_in_launch_at
-- confirmed live this session via information_schema, project
-- yeszghaspzwwstvsrioa). Ben approved building ahead of merge order (bus
-- 19:58:00Z) -- this migration is NOT applied to prod by this session; it is
-- committed and pushed for the eventual PR, to be applied AFTER the
-- notify-admin-new-partner Edge Function is deployed and byte-verified
-- (nothing reaches main that calls something not yet live).
--
-- Additive only: one new trigger function + one new AFTER INSERT trigger on
-- public.referral_agents. No existing table, column, function, trigger or
-- constraint is altered or dropped. Confirmed live this session:
-- public.notifications.notification_type has NO CHECK constraint (pg_constraint
-- query, contype='c', zero rows) -- so no constraint change is needed for the
-- new 'admin_new_partner_alert' notification_type value.
--
-- Mechanism copied from the notify_admin_new_contractor / trg_notify_admin_new_contractor
-- pattern (supabase/migrations/20260817222018_gh752_move_notify_functions_to_vault.sql),
-- exactly for how the URL and key are resolved: SECURITY DEFINER plpgsql
-- trigger function, service-role key resolved from vault.decrypted_secrets
-- (name='cron_service_role_key' -- confirmed present live this session,
-- the same secret 10+ live cron jobs and every notify_admin_new_* trigger
-- already uses), hardcoded project URL, net.http_post with the key as
-- Bearer token, pg_net failures caught and RAISE LOGged, never raised (a
-- partner signup insert must never fail because the alert call failed).
--
-- DEVIATION FROM THE CONTRACTOR TRIGGER (deliberate, documented -- same
-- deviation gh-1932's homeowner triggers already made): the live
-- notify_admin_new_contractor() body passes
-- `jsonb_build_object(...)::text::bytea` to net.http_post's `body` param.
-- That cast does not match the installed net.http_post(url text, body
-- jsonb, ...) signature -- it throws 42883 on every call, silently
-- swallowed by the EXCEPTION handler, confirmed live: notifications with
-- notification_type='admin_new_contractor' has zero rows despite regular
-- contractor signups. This is a known, out-of-scope bug in that sibling
-- (flagged there by gh-1932, not fixed by this migration either -- no write
-- authority over that function here). P-3 does NOT repeat it: body is
-- passed as jsonb directly, matching gh-1932's already-corrected calls.
--
-- FAIL-CLOSED (P-2 lesson): the only guard here is "vault secret not found
-- -> RETURN NEW without calling net.http_post" -- i.e. on a NULL/missing
-- key, NO alert is attempted (fails closed: no request goes out), it does
-- NOT fall through to an insecure or default-permit path. All is_test /
-- bot-pattern-vs-alert decisioning (Ben's DECIDED rule: is_test=true always
-- alerts with a [TEST] prefix and wins over a bot-pattern match; a bot
-- pattern without is_test skips) lives in the notify-admin-new-partner Edge
-- Function itself, not in this trigger -- the trigger fires unconditionally
-- on every INSERT and lets the Edge Function decide, so a future change to
-- that policy needs only an Edge Function deploy, not a new migration.
--
-- AFTER INSERT only (no OR UPDATE OF status, unlike the contractor
-- trigger): a partner row has no status-transition analogous to
-- contractors.status entering 'pending_approval' to gate on -- P-1's
-- register_partner always does a direct INSERT.
--
-- ORDER GUARD (REVIEW FAIL 5833567534, must-fix 1): this migration's own
-- timestamp (20260924200316) sorts BEFORE
-- 20260925131429_gh2154_p3_notifications_referral_agent_id.sql, which adds
-- notifications.referral_agent_id -- the column the Edge Function's dedupe
-- query filters on. Nothing structural stopped the trigger from going live
-- before that column exists; if it did, every partner INSERT would call
-- the Edge Function, its `.eq("referral_agent_id", ...)` dedupe query would
-- error 42703 (undefined_column), the Edge Function would fail closed
-- (500, no send -- see notify-admin-new-partner/index.ts), and pg_net does
-- not retry, so the alert would be silently lost with nothing reporting
-- it. The correct go-live order is: apply 20260925131429 first, read it
-- back, deploy the Edge Function with a byte read-back, THEN apply this
-- migration (see sql/schema-pending.json "notifications" entry and PR
-- #2170's Deploy order section). This guard makes applying it out of that
-- order fail loudly at migration time instead of failing silently at
-- runtime.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'notifications'
       AND column_name  = 'referral_agent_id'
  ) THEN
    RAISE EXCEPTION 'gh2154_p3_partner_new_alert_trigger: public.notifications.referral_agent_id does not exist yet -- apply supabase/migrations/20260925131429_gh2154_p3_notifications_referral_agent_id.sql BEFORE this migration. Applying this trigger first would make every partner-signup alert fail silently (see REVIEW FAIL 5833567534, must-fix 1).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.notify_admin_new_partner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net'
AS $function$
DECLARE
  v_service_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_partner: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-partner',
    body    := jsonb_build_object('partner_id', NEW.id),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_partner: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.notify_admin_new_partner() IS
'gh-2154 P-3: fires via pg_net on referral_agents INSERT. Calls the notify-admin-new-partner Edge Function to alert Dustin of a new partner signup. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

DROP TRIGGER IF EXISTS trg_notify_admin_new_partner ON public.referral_agents;

CREATE TRIGGER trg_notify_admin_new_partner
  AFTER INSERT ON public.referral_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_new_partner();

COMMENT ON TRIGGER trg_notify_admin_new_partner ON public.referral_agents IS
'gh-2154 P-3: fires after INSERT on referral_agents. Calls notify_admin_new_partner() to alert Dustin of a new partner signup.';

COMMIT;
