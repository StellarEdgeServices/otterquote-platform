-- Rollback for supabase/migrations_drafts/gh969_hover_rebate_trigger_completion.sql
-- gh-969 / D-291 trigger half. DRAFT — the forward migration has not been
-- applied, so this has not been exercised. Restores the pre-migration state
-- byte-for-byte against the baseline definition
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql:3247 /
-- 20260812182824_gh720_move_hardcoded_secret_to_vault.sql:43-62), i.e. the
-- signing-time trigger this migration is meant to retire.
--
-- hover_orders is empty at draft time (verified 2026-08-20), so there is no
-- data to reconcile in either direction — this is a pure DDL rollback.

BEGIN;

DROP TRIGGER IF EXISTS after_claim_completed_rebate ON public.claims;

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

COMMENT ON FUNCTION public.notify_hover_rebate() IS
'Restored by rollback of gh969_hover_rebate_trigger_completion (D-291 trigger
half): fires off a quotes row again, payload keyed on NEW.claim_id. This is the
pre-D-291-trigger-fix behavior — payment_status=succeeded (contract signing),
not job completion. Rolling back re-introduces the gh-969 defect (rebate wakes
at the wrong time / never fires on the intended signal); do so only if the
forward migration itself is found defective, not to "undo D-291".';

DROP TRIGGER IF EXISTS after_quote_paid_rebate ON public.quotes;

CREATE TRIGGER after_quote_paid_rebate
  AFTER UPDATE OF payment_status ON public.quotes
  FOR EACH ROW
  WHEN (
    (NEW.payment_status = 'succeeded'::text)
    AND (OLD.payment_status IS DISTINCT FROM 'succeeded'::text)
  )
  EXECUTE FUNCTION public.notify_hover_rebate();

COMMIT;
