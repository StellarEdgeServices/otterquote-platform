-- gh720_move_hardcoded_secret_to_vault
--
-- Applied directly to production (project yeszghaspzwwstvsrioa) via
-- apply_migration on 2026-08-12; this file reproduces that applied change
-- for version control (GitHub #770 follow-up to #720).
--
-- Rewrites the two SECURITY DEFINER trigger functions that previously read
-- a hardcoded service-role secret literal to instead read it from
-- vault.decrypted_secrets['cron_service_role_key']. Idempotent
-- (CREATE OR REPLACE) — matches the live function bodies byte-for-byte as
-- of 2026-08-12; running this against the already-migrated database is a
-- no-op, not a re-application of a destructive change.

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
$function$
;

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
$function$
;
