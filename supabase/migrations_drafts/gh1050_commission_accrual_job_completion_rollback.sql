-- Rollback: gh1050_commission_accrual_job_completion_rollback.sql
-- Reverts: gh1050_commission_accrual_job_completion.sql
-- Status: DRAFT ONLY — forward migration not yet applied (D-182 approval pending).
--
-- Restores apply_referral_commission() to its current live body (byte-
-- identical, captured via pg_get_functiondef() on 2026-08-19, matching the
-- gh-752 Vault-based pattern), drops after_claim_completed, and recreates
-- after_quote_paid on quotes exactly as it exists in production today.
--
-- No data cleanup required: at the time this migration is proposed,
-- payout_approvals = 0 rows and total_commission_paid = $0.00 across all
-- referral_agents (re-verified live, 2026-08-19T20:4x — see PR body / issue
-- #1050 comment). If any accrual has occurred under the new (claims-
-- completion-triggered) regime by the time a rollback is actually needed,
-- STOP and hand-reconcile those specific payout_approvals / referrals rows
-- before running this rollback — this file assumes zero accrued rows, same
-- as the forward migration's own pre-condition.

BEGIN;

-- Drop the new claims-based trigger.
DROP TRIGGER IF EXISTS after_claim_completed ON public.claims;

-- Restore apply_referral_commission() to its pre-gh-1050 (current live) body.
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
  -- 1. Locate the referral via the quote's claim.
  SELECT referral_id INTO v_claim_referral_id
    FROM public.claims
    WHERE id = NEW.claim_id;

  IF v_claim_referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 2. Load and lock the referral row.
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = v_claim_referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 3. Idempotency: if commission was already applied, do not re-apply.
  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- 4. Load the referrer.
  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 5. Apply the $200 referrer bonus and advance status to 'contract_signed'.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status IN ('job_completed', 'commission_paid')
                                 THEN status
                               ELSE 'contract_signed'
                             END
   WHERE id = v_referral.id;

  -- 6. Insert payout_approval for the referral commission.
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

  -- 7. Forward-only recruit bonus per D-142.
  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at >= v_referrer.recruited_at THEN

    UPDATE public.referrals
       SET recruit_commission_amount = 50
     WHERE id = v_referral.id;

    UPDATE public.referral_agents
       SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
     WHERE id = v_referrer.recruited_by_id;

    -- Load recruiter name for the approval row.
    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    -- Insert payout_approval for the recruit commission.
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

  -- 8. Fire notify-payout-pending via pg_net (async, fire-and-forget).
  -- gh-752: service-role key resolved from Vault. A missing Vault secret is
  -- RAISE LOGged instead of skipped silently. EXCEPTION handler still
  -- swallows any pg_net failure — payment integrity is never at risk.
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

COMMENT ON FUNCTION public.apply_referral_commission() IS
'D-180 (v52)/v94/gh-752: On payment_status transition to succeeded (>=$10K job), attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, and fires notify-payout-pending via pg_net (Vault-based key). Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect payment integrity.';

-- Recreate after_quote_paid exactly as it exists in production today.
DROP TRIGGER IF EXISTS after_quote_paid ON public.quotes;

CREATE TRIGGER after_quote_paid
  AFTER UPDATE OF payment_status ON public.quotes
  FOR EACH ROW
  WHEN (
    NEW.payment_status = 'succeeded'
    AND OLD.payment_status IS DISTINCT FROM 'succeeded'
    AND COALESCE(NEW.total_price, 0) >= 10000
  )
  EXECUTE FUNCTION public.apply_referral_commission();

COMMENT ON TRIGGER after_quote_paid ON public.quotes IS
'Fires once per quote when payment_status transitions to succeeded on a job >= $10K. Entry point for D-139/D-140/D-141/D-142/D-180 commission accrual. See apply_referral_commission().';

COMMIT;
