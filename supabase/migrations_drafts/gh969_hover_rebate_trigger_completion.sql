-- gh-969: D-291 trigger half — hover/RoofScope rebate, contract-signing -> job completion
-- Tier 3 (D-182). DRAFT ONLY. NOT APPLIED. Mirrors the gh-1050/D-283 precedent
-- (supabase/migrations/20260819225113_gh1050_commission_accrual_job_completion.sql),
-- which already retargeted the sibling referral-commission trigger from
-- quotes.payment_status='succeeded' to claims.completion_date for the same reason.
--
-- Drafted 2026-08-20 (session rw-f22-20260820T204228-ec09, Code lane,
-- bridge-overdrive-20260820T1928Z) per SG-3 on In Flight/lanes/code-lane.md.
-- No R-097 notice has been posted for this migration. No apply_migration or
-- db push has been run. Do not apply without a posted, provably-expired R-097
-- notice and Dustin's Tier 3 approval (D-182).
--
-- ── Why ──────────────────────────────────────────────────────────────────
-- D-291 (2026-08-17, Dustin-locked) moves the $15 RoofScope rebate from firing
-- at contract signing to firing at job completion. The Edge Function half is
-- already done: process-hover-rebate was redeployed to v33 (2026-08-20T19:44:09Z,
-- PR #1098) and now gates the refund on claims.completion_date being set. But
-- the DB trigger that WAKES that function was never touched by that redeploy
-- and still fires on the OLD signal:
--
--   CREATE TRIGGER after_quote_paid_rebate AFTER UPDATE OF payment_status
--     ON public.quotes FOR EACH ROW
--     WHEN ((new.payment_status = 'succeeded') AND (old.payment_status IS DISTINCT FROM 'succeeded'))
--     EXECUTE FUNCTION notify_hover_rebate()
--   (live pg_trigger read, 2026-08-20T20:42Z: unchanged since baseline. Repo
--   definition: supabase/migrations/20260101000000_v000_baseline_schema.sql:3247,
--   re-declared unchanged at supabase/migrations/20260812182824_gh720_move_hardcoded_secret_to_vault.sql)
--
-- Net effect today: the trigger fires at signing, wakes v33, v33 checks
-- claims.completion_date, finds it unset (job just signed, not done), and
-- declines -- a wasted no-op pg_net POST, not a failure. The trigger never
-- fires again later at actual completion, because nothing updates
-- quotes.payment_status at that point.
--
-- CORRECTION (2026-08-21, gh-1162): an adversarial re-verification on
-- 2026-08-20 refuted the "the rebate never pays" framing this section
-- originally carried. It does still pay: cron jobid 10
-- (process-hover-rebate-scan, */30 * * * *, 5,667+ succeeded runs) invokes
-- process-hover-rebate in scan mode independently of this trigger, gating
-- each row on the same claims.completion_date condition -- already the
-- correct D-291 signal. The real, smaller defect this migration fixes is
-- (a) the wasted no-op POST at signing, and (b) up to 30 minutes of added
-- latency before the scan picks up the completion. Neither is "the rebate
-- never pays." This changes the urgency, not the fix or the tier.
--
-- ── Live blast-radius, re-verified at draft time (R-107, not carried forward) ──
-- select count(*) from hover_orders                                        -> 0
-- select count(*) from hover_orders where rebate_due AND rebate_paid_at IS NULL -> 0
-- select count(*) from quotes where payment_status='succeeded'             -> 1
-- select count(*) from claims where completion_date IS NOT NULL            -> 1
-- (all live reads against prod yeszghaspzwwstvsrioa, 2026-08-20T20:4xZ, this session)
-- hover_orders is empty, so neither the old nor the new trigger has anything
-- to act on today. Zero live exposure. This is the reason the change is safe
-- to draft now — not a reason it stops being Tier 3.
--
-- ── What this migration does ────────────────────────────────────────────
-- 1. Drops after_quote_paid_rebate on public.quotes.
-- 2. Redefines notify_hover_rebate() to read the claim id off NEW.id instead
--    of NEW.claim_id, because the trigger now fires FROM public.claims (whose
--    own primary key IS the claim id), not FROM public.quotes (which has a
--    claim_id foreign key). This is the exact same NEW-shape change gh-1050
--    made to apply_referral_commission() for the identical reason. The
--    process-hover-rebate payload contract is unchanged: POST { claim_id }.
-- 3. Creates after_claim_completed_rebate on public.claims, firing once on the
--    NULL -> set transition of completion_date (the same signal gh-1050 uses,
--    and the sole write path is the mark-job-complete Edge Function, verified
--    supabase/functions/mark-job-complete/index.ts:404 `.update({ completion_date })`
--    on the claims table). Named distinctly from gh-1050's own
--    after_claim_completed trigger (which calls apply_referral_commission(),
--    a different function) to avoid a naming collision on public.claims.
--
-- ── What this migration does NOT do ─────────────────────────────────────
-- Does not touch quotes.payment_status, does not touch hover_orders schema,
-- does not touch process-hover-rebate (already deployed, v33). Does not touch
-- the referral-commission trigger/function (gh-1050, separate and already done).
-- Does not backfill or reprocess any historical row — hover_orders is empty,
-- so there is nothing to backfill.
--
-- Rollback: supabase/migrations_rollbacks/gh969_hover_rebate_trigger_completion_rollback.sql
-- GitHub: #969 (D-291 trigger half, second reopen)

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
'gh-969/D-291 (drafted 2026-08-20, NOT YET APPLIED): retargeted from firing off a
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
'gh-969/D-291 (drafted 2026-08-20, NOT YET APPLIED): fires notify_hover_rebate()
once, on the transition of claims.completion_date from NULL to a value — job
completion (mark-job-complete Edge Function''s sole write path). Supersedes
after_quote_paid_rebate (dropped by this same migration), which fired too early,
at contract signing. Distinct trigger from gh-1050''s after_claim_completed
(which calls the unrelated apply_referral_commission()) — both live on
public.claims, on the same completion_date column, without colliding, because
Postgres fires all matching AFTER triggers on a row in name order.';

COMMIT;
