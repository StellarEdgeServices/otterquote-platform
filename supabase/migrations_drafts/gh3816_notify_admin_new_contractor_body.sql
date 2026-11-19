-- gh-3816: fix public.notify_admin_new_contractor() so its net.http_post call resolves (jsonb body, not ::text::bytea), and stop swallowing failures silently.
-- STATUS (gh-1438, as of 2026-11-19): NOT APPLIED
-- EVIDENCE: drafted on main f64abdbf. Read-only production reads by the author on 2026-11-19 (Supabase SELECT, project yeszghaspzwwstvsrioa): pg_net 0.20.0 has exactly one net.http_post overload, (text, jsonb, jsonb, jsonb, integer); pg_get_functiondef of notify_admin_new_contractor() passes body := jsonb_build_object('contractor_id', NEW.id)::text::bytea (there is no bytea-to-jsonb cast, so the call raises 42883 on every execution and the EXCEPTION WHEN OTHERS handler swallows it); the installed body is the same as supabase/migrations/20260817222018_gh752_move_notify_functions_to_vault.sql (repo = production, no drift). Target Edge Function notify-admin-new-contractor reads req.json().contractor_id (a string) and nothing else.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair, R-097 24-hour notice, Dustin's GO, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_rollback.sql (restores the installed body, broken bytea call included)
-- Pre-flight: supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_pre-flight.md  Proof (BEGIN ... ROLLBACK, throwaway Postgres + stub pg_net): supabase/tests/gh3816_notify_admin_new_contractor_body_proof.sql
--
-- What changes (three things, all inside the one function body; owner, SECURITY DEFINER, search_path and grants are preserved by CREATE OR REPLACE and re-asserted by the proof):
--   1. net.http_post body: jsonb_build_object('contractor_id', NEW.id)::text::bytea  ->  jsonb_build_object('contractor_id', NEW.id)   [the fix; same shape the working notify_admin_new_partner uses]
--   2. BEHAVIOUR ADDITION (reviewer: read this): the EXCEPTION WHEN OTHERS handler used to only RAISE LOG. It still never blocks the signup (it returns NEW), but it now also writes one row to
--      public.platform_alerts_log (alert_type 'contractor_admin_notify_failed', function_name 'notify_admin_new_contractor', message with contractor id, SQLSTATE and SQLERRM; no email address or name).
--      The five working sibling functions do nothing beyond RAISE LOG, so this is new, deliberate, and the reason the defect hid for five months. The row appears in the admin panel's alert list (admin-contractors.html reads this table); it does not send an email by itself.
--      The log write sits in its own nested BEGIN ... EXCEPTION block, so even a failing log write cannot stop the INSERT of the contractor.
--   3. The "vault secret cron_service_role_key not found" skip branch gets the same visible row (alert_type 'contractor_admin_notify_failed'), because it is the other way this function can silently send nothing.
-- Unchanged on purpose: the status filter, the test-account email filter (otterquote-internal.test / pfw- / authdoctor, identical to the Edge Function's filter), the URL, the headers, the Vault key lookup, the trigger itself.
-- Known limit: net.http_post is asynchronous. This handler sees only failures that happen while ENQUEUEING the request (resolution, Vault, permissions). A non-2xx answer from the Edge Function later is recorded only in net._http_response (about 6 h retention); it is not caught here.
-- No new function is created (migration-author Step 1 pattern 9 not triggered): CREATE OR REPLACE keeps the existing ACL. No secret literal appears; the key is read from Vault exactly as notify_admin_new_partner does.

CREATE OR REPLACE FUNCTION public.notify_admin_new_contractor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
DECLARE
  v_service_key  TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status != 'pending_approval' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status != 'pending_approval' THEN
      RETURN NEW;
    END IF;
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.email ILIKE '%otterquote-internal.test%'
     OR NEW.email ILIKE '%pfw-%'
     OR NEW.email ILIKE '%authdoctor%' THEN
    RAISE LOG 'notify_admin_new_contractor: skipping test account id=% email=%', NEW.id, NEW.email;
    RETURN NEW;
  END IF;

  -- gh-752: resolve the service-role key from Vault (proven live by 10 cron
  -- jobs) instead of the app.* GUCs, which are not set on this database.
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_contractor: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    -- gh-3816: make the skip visible (never blocks the signup).
    BEGIN
      INSERT INTO public.platform_alerts_log (alert_type, function_name, message)
      VALUES ('contractor_admin_notify_failed', 'notify_admin_new_contractor',
              format('Admin alert for new contractor %s NOT sent: vault secret cron_service_role_key not found.', NEW.id));
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'notify_admin_new_contractor: could not record alert for id=% sqlstate=% sqlerrm=%', NEW.id, SQLSTATE, SQLERRM;
    END;
    RETURN NEW;
  END IF;

  -- gh-3816: body is the jsonb value itself. pg_net 0.20.0 has only
  -- net.http_post(url text, body jsonb, params jsonb, headers jsonb,
  -- timeout_milliseconds integer); the former text-to-byte-string cast matched no overload.
  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-contractor',
    body    := jsonb_build_object('contractor_id', NEW.id),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_contractor: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  -- gh-3816: a notify failure must never block a signup, but it must not be invisible either.
  BEGIN
    INSERT INTO public.platform_alerts_log (alert_type, function_name, message)
    VALUES ('contractor_admin_notify_failed', 'notify_admin_new_contractor',
            format('Admin alert for new contractor %s NOT sent: sqlstate=%s sqlerrm=%s', NEW.id, SQLSTATE, SQLERRM));
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'notify_admin_new_contractor: could not record alert for id=% sqlstate=% sqlerrm=%', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
