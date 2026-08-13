-- gh-720: hardcoded sb_secret_ key in two SECURITY DEFINER trigger functions, world-readable
-- via pg_proc.prosrc to anon/authenticated. Applied to production 2026-08-12 with no repo
-- file (captured retroactively here, introspection-generated per the #385 baseline method —
-- no pg_dump access from this session either).
--
-- gh-720's own AC suggested rewriting to current_setting('app.service_role_key', true), matching
-- apply_referral_commission / notify_admin_new_contractor. That setting is NOT configured on
-- this database (see #752) and would have silently no-opped both webhooks. The rotation thread
-- caught this and used the Vault pattern instead, proven live by the 10 pg_cron jobs migrated
-- in gh-688 (PR #731): vault.decrypted_secrets['cron_service_role_key'].
--
-- Body text below is introspected verbatim from production (pg_get_functiondef) to guarantee
-- byte-for-byte parity with what is actually live — not retyped from memory.

CREATE OR REPLACE FUNCTION public.notify_feature_request_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  payload jsonb;
BEGIN
  payload := jsonb_build_object(
    'type',   'INSERT',
    'table',  'feature_requests',
    'record', row_to_json(NEW)::jsonb
  );

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-feature-request',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key')
    ),
    body    := payload
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_hover_rebate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    PERFORM net.http_post(
      url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-hover-rebate',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key')
      ),
      body    := jsonb_build_object('claim_id', NEW.claim_id)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'notify_hover_rebate pg_net call failed for claim %: %', NEW.claim_id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
