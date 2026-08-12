-- ============================================================================
-- v85: Admin notification trigger for new contractor signups
--
-- Creates a PostgreSQL trigger function and trigger that fires via pg_net
-- when a contractor enters pending_approval status (INSERT or UPDATE).
-- Calls the notify-admin-new-contractor Edge Function.
--
-- Idempotency: the EF checks the notifications table before sending,
-- so duplicate trigger fires are safe.
--
-- Test account filter: applied at both trigger level (email check) and
-- EF level (belt-and-suspenders).
--
-- Prerequisites:
--   - pg_net extension enabled (confirmed: used since v44)
--   - app.supabase_url and app.service_role_key must be set in db.settings
--     (same requirement as v49 notify-partner-w9 trigger)
--   - notify-admin-new-contractor Edge Function must be deployed to Supabase
--
-- Deploy steps (Tier 3 — Dustin action required):
--   1. Apply this migration (Supabase MCP apply_migration or CLI)
--   2. Deploy EF: supabase functions deploy notify-admin-new-contractor
--      --project-ref yeszghaspzwwstvsrioa
--
-- ClickUp: 86e1nr89h
-- ============================================================================

BEGIN;

-- ============================================================================
-- TRIGGER FUNCTION
-- ============================================================================

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
  -- Only fire on INSERT with status = pending_approval,
  -- or on UPDATE where status transitions TO pending_approval.
  IF TG_OP = 'INSERT' AND NEW.status != 'pending_approval' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Skip if not transitioning TO pending_approval
    IF NEW.status != 'pending_approval' THEN
      RETURN NEW;
    END IF;
    -- Skip if status did not change (re-save with no status change)
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip test accounts
  IF NEW.email ILIKE '%otterquote-internal.test%'
     OR NEW.email ILIKE '%pfw-%'
     OR NEW.email ILIKE '%authdoctor%' THEN
    RAISE LOG 'notify_admin_new_contractor: skipping test account id=% email=%', NEW.id, NEW.email;
    RETURN NEW;
  END IF;

  -- Read connection settings
  v_supabase_url := current_setting('app.supabase_url', true);
  v_service_key  := current_setting('app.service_role_key', true);

  IF v_supabase_url IS NULL OR v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_contractor: app.supabase_url or app.service_role_key not set — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  -- Fire-and-forget HTTP POST to Edge Function via pg_net
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
'Fires via pg_net when a contractor enters pending_approval status. '
'Calls the notify-admin-new-contractor Edge Function to send Dustin an admin email. '
'SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

-- ============================================================================
-- TRIGGER
-- ============================================================================

DROP TRIGGER IF EXISTS trg_notify_admin_new_contractor ON public.contractors;

CREATE TRIGGER trg_notify_admin_new_contractor
  AFTER INSERT OR UPDATE OF status
  ON public.contractors
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_new_contractor();

COMMENT ON TRIGGER trg_notify_admin_new_contractor ON public.contractors IS
'Fires after INSERT or status UPDATE on contractors. '
'Calls notify_admin_new_contractor() to alert Dustin when a new contractor enters pending_approval.';

COMMIT;
