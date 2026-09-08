-- Migration: v85_notify_admin_new_contractor
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-06-02T15:53:43Z, recorded in
-- supabase_migrations.schema_migrations as version 20260602155343, name
-- "v85_notify_admin_new_contractor". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_admin_new_contractor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_supabase_url TEXT;
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

  v_supabase_url := current_setting('app.supabase_url', true);
  v_service_key  := current_setting('app.service_role_key', true);

  IF v_supabase_url IS NULL OR v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_contractor: app.supabase_url or app.service_role_key not set — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_supabase_url || '/functions/v1/notify-admin-new-contractor',
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
$$;

COMMENT ON FUNCTION public.notify_admin_new_contractor() IS
'Fires via pg_net when a contractor enters pending_approval status. Calls the notify-admin-new-contractor Edge Function to send Dustin an admin email. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

DROP TRIGGER IF EXISTS trg_notify_admin_new_contractor ON public.contractors;

CREATE TRIGGER trg_notify_admin_new_contractor
  AFTER INSERT OR UPDATE OF status
  ON public.contractors
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_new_contractor();

COMMENT ON TRIGGER trg_notify_admin_new_contractor ON public.contractors IS
'Fires after INSERT or status UPDATE on contractors. Calls notify_admin_new_contractor() to alert Dustin when a new contractor enters pending_approval.';

COMMIT;
