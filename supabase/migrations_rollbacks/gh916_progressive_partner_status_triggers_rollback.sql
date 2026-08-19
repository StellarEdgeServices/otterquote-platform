-- Rollback: gh916_progressive_partner_status_triggers_rollback.sql
-- Reverts: supabase/migrations/20260819211149_gh916_progressive_partner_status_triggers.sql
--
-- Restores claims_advance_referral() and apply_referral_commission() to their
-- pre-migration live bodies (byte-identical to baseline / gh-752 respectively),
-- and drops the new trigger + function added for the stage-2 (bid_received)
-- signal. No data is destroyed by this rollback — it only reverts
-- function/trigger definitions, not any rows written by
-- send-partner-status-email itself (referrals.metadata.partner_status_series
-- stamps are left in place; that is send-partner-status-email's own
-- idempotency data, not owned by this migration).
--
-- Use: run this file directly against project yeszghaspzwwstvsrioa via
-- apply_migration (or psql) if the forward migration in
-- 20260819211149_gh916_progressive_partner_status_triggers.sql needs to be
-- undone.

BEGIN;

-- Drop the new stage-2 trigger + function entirely.
DROP TRIGGER IF EXISTS trg_notify_partner_status_on_bid_submitted ON public.quotes;
DROP FUNCTION IF EXISTS public.notify_partner_status_on_bid_submitted();

-- Restore claims_advance_referral() to its pre-migration body.
CREATE OR REPLACE FUNCTION public.claims_advance_referral()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    UPDATE referrals
       SET status = 'claim_submitted'
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered');
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never break the claim write
  END;
  RETURN NEW;
END;
$function$
;

-- Restore apply_referral_commission() to its gh-752 (current live) body.
CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim_referral_id   UUID;
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_service_role_key    TEXT;
BEGIN
  SELECT referral_id INTO v_claim_referral_id
    FROM public.claims
    WHERE id = NEW.claim_id;

  IF v_claim_referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = v_claim_referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status IN ('job_completed', 'commission_paid')
                                 THEN status
                               ELSE 'contract_signed'
                             END
   WHERE id = v_referral.id;

  INSERT INTO public.payout_approvals (
    referral_id, payout_type, partner_id, partner_name,
    amount, trigger_event, status, auto_approve_at
  )
  VALUES (
    v_referral.id,
    'commission_referral',
    v_referrer.id,
    TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')),
    200,
    'Fee charged — referral ' || v_referral.id::TEXT || ' (quote ' || NEW.id::TEXT || ')',
    'pending_approval',
    NOW() + INTERVAL '7 days'
  )
  RETURNING id INTO v_referral_approval;

  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at >= v_referrer.recruited_at THEN

    UPDATE public.referrals
       SET recruit_commission_amount = 50
     WHERE id = v_referral.id;

    UPDATE public.referral_agents
       SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
     WHERE id = v_referrer.recruited_by_id;

    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    INSERT INTO public.payout_approvals (
      referral_id, payout_type, partner_id, partner_name,
      amount, trigger_event, status, auto_approve_at
    )
    VALUES (
      v_referral.id,
      'commission_recruit',
      v_referrer.recruited_by_id,
      TRIM(COALESCE(v_recruiter.first_name, '') || ' ' || COALESCE(v_recruiter.last_name, '')),
      50,
      'Recruit bonus — referral ' || v_referral.id::TEXT || ' (referrer: ' || TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')) || ')',
      'pending_approval',
      NOW() + INTERVAL '7 days'
    )
    RETURNING id INTO v_recruit_approval;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_role_key
      FROM vault.decrypted_secrets
     WHERE name = 'cron_service_role_key';

    IF v_service_role_key IS NULL THEN
      RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping notify-payout-pending for approval_id=%', v_referral_approval;
    ELSIF v_referral_approval IS NOT NULL THEN
      PERFORM net.http_post(
        url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-payout-pending',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_role_key
        ),
        body    := jsonb_build_object(
          'payout_approval_id', v_referral_approval
        )
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE LOG 'apply_referral_commission: pg_net call to notify-payout-pending failed (non-fatal). approval_id=% sqlstate=% sqlerrm=%',
        v_referral_approval, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMIT;
