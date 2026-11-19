-- gh-3816 ROLLBACK: restore public.notify_admin_new_contractor() to the body installed in production on 2026-11-19 (= supabase/migrations/20260817222018_gh752_move_notify_functions_to_vault.sql, part 1 of 2).
-- WARNING: that body is the BROKEN one (net.http_post body cast ::text::bytea matches no installed overload; the call fails and is swallowed). Run only if the forward change must be reverted; after a rollback nobody is told about a new contractor by the database trigger.
-- Run manually only. Never move into supabase/migrations/ (the CLI would replay it forward). The proof runs this file from its real path as the "before" state.
-- Owner, SECURITY DEFINER, search_path and grants are untouched by CREATE OR REPLACE.

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
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-contractor',
    body    := jsonb_build_object('contractor_id', NEW.id)::text::bytea,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_contractor: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;
