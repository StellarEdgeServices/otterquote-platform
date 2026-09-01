-- Migration: gh969_hover_rebate_trigger_completion
-- Filed by: gh-1438 migration reconciliation batch (Code lane)
-- Date filed: 2026-09-01
-- Original issue: #969, D-291 trigger half
-- Rollback: supabase/migrations_rollbacks/gh969_hover_rebate_trigger_completion_rollback.sql
--           (pre-existing, untimestamped — filed separately before this
--           reconciliation; content targets this same migration)
-- Pre-flight: supabase/migrations_rollbacks/20260824184631_gh969_hover_rebate_trigger_completion_pre-flight.md
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 reconciliation (issue #1438) — it does NOT re-apply anything;
-- merging this PR is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-24, recorded in
-- supabase_migrations.schema_migrations as version 20260824184631,
-- name "gh969_hover_rebate_trigger_completion".
--
-- PROVENANCE: originally drafted as
-- supabase/migrations_drafts/gh969_hover_rebate_trigger_completion.sql
-- (left in place, untouched, for full annotated history). The applied
-- statement's own header comment claims it was applied "verbatim" from
-- that draft; a read-only diff (gh-1438 reconciliation, 2026-09-01) found
-- the trigger/function logic is in fact identical, but the two
-- COMMENT ON FUNCTION / COMMENT ON TRIGGER string literals were reworded
-- at apply time (draft said "drafted ... NOT YET APPLIED"; the text
-- actually recorded as applied says "applied 2026-08-24, Dustin-approved").
-- The SQL body below is copied verbatim from
-- supabase_migrations.schema_migrations.statements for this version — it
-- is the literal record of what ran, not a retype of the draft.

BEGIN;

DROP TRIGGER IF EXISTS after_quote_paid_rebate ON public.quotes;

CREATE OR REPLACE FUNCTION public.notify_hover_rebate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    -- gh-969/D-291: NEW is now a claims row (trigger moved from
    -- quotes.payment_status to claims.completion_date). The claim's own id
    -- IS the claim_id the Edge Function expects — no join through
    -- quotes.claim_id needed anymore (mirrors gh-1050's identical change to
    -- apply_referral_commission()).
    PERFORM net.http_post(
      url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-hover-rebate',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key')
      ),
      body    := jsonb_build_object('claim_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'notify_hover_rebate pg_net call failed for claim %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.notify_hover_rebate() IS
'gh-969/D-291 (applied 2026-08-24, Dustin-approved): retargeted from firing off a
quotes row (payment_status=succeeded, i.e. contract signing under D-127) to firing
off a claims row (completion_date set, i.e. job completion — sole write path:
mark-job-complete Edge Function). Payload to process-hover-rebate is unchanged
({claim_id}); the value now comes from NEW.id (the claims PK) instead of
NEW.claim_id (a quotes FK), mirroring gh-1050/D-283''s identical retarget of
apply_referral_commission(). SECURITY DEFINER; pg_net failures are logged and
swallowed so a notify failure never blocks the completion write that fired it.';

DROP TRIGGER IF EXISTS after_claim_completed_rebate ON public.claims;

CREATE TRIGGER after_claim_completed_rebate
  AFTER UPDATE OF completion_date ON public.claims
  FOR EACH ROW
  WHEN (
    NEW.completion_date IS NOT NULL
    AND OLD.completion_date IS NULL
  )
  EXECUTE FUNCTION public.notify_hover_rebate();

COMMENT ON TRIGGER after_claim_completed_rebate ON public.claims IS
'gh-969/D-291 (applied 2026-08-24): fires notify_hover_rebate()
once, on the transition of claims.completion_date from NULL to a value — job
completion (mark-job-complete Edge Function''s sole write path). Supersedes
after_quote_paid_rebate (dropped by this same migration), which fired too early,
at contract signing. Distinct trigger from gh-1050''s after_claim_completed
(which calls the unrelated apply_referral_commission()) — both live on
public.claims, on the same completion_date column, without colliding, because
Postgres fires all matching AFTER triggers on a row in name order.';

COMMIT;
