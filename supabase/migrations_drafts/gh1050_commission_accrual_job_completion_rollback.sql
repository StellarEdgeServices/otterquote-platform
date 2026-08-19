-- Rollback: gh1050_commission_accrual_job_completion_rollback.sql (REBASED)
-- Reverts: gh1050_commission_accrual_job_completion.sql
-- Status: rebased 2026-08-19 (session rw-1050-f22-apply2) against the live
--   POST-gh-916 function body — the original draft's rollback restored a
--   PRE-gh-916 body, which would have silently dropped gh-916's step 9
--   (send-partner-status-email) if ever run. This version restores the
--   function to exactly the body captured via pg_get_functiondef() against
--   production yeszghaspzwwstvsrioa on 2026-08-19, immediately before this
--   migration applied (i.e. post-gh-916, pre-gh-1050).
--
-- No data cleanup required IF the only accrual under the new (claims-
-- completion-triggered) regime is the known post-apply smoke-test row.
-- Re-check payout_approvals / referrals live before running this rollback —
-- if any OTHER row exists (i.e. a real, non-test claim completed and accrued
-- under the new trigger), STOP and hand-reconcile that row before running
-- this file.
--
-- Live blast-radius re-verify immediately before this migration applied
-- (2026-08-19T22:5x, this session): payout_approvals = 0 rows,
-- total_commission_paid = $0.00, total_commission_earned = $0.00,
-- referrals_with_commission = 0 across all 8 referrals, quotes with
-- payment_status='succeeded' = 0.
--
-- Post-apply smoke test (same session) then intentionally created exactly
-- ONE accrual: referral_id ea75db9f-0f49-4aec-aaa4-45cc82ef7aa3 (the
-- designated E2E TEST CLAIM, claim_id 8dcf76f1-f518-4363-a37f-192dec10b9bb,
-- is_test=true, agent email dustinstohler1+jjdemo0805@gmail.com — Dustin's
-- own inbox, no real partner). If rolling back, that one payout_approvals
-- row (payout_type='commission_referral', amount=200, referral_id
-- ea75db9f-0f49-4aec-aaa4-45cc82ef7aa3) and the referral's
-- commission_amount/job_value/status fields are test-fixture data and do not
-- need hand-reconciliation — this file's DROP/CREATE FUNCTION statements do
-- not touch existing table rows either way, so no separate cleanup step is
-- required even for that row.

BEGIN;

-- Drop the new claims-based trigger.
DROP TRIGGER IF EXISTS after_claim_completed ON public.claims;

-- Restore apply_referral_commission() to its live post-gh-916/pre-gh-1050
-- body, byte-identical to pg_get_functiondef() captured 2026-08-19.
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
  -- gh-752: service-role key now resolved from Vault; the app.* GUCs this
  -- block used to read are not set on this database, which silently skipped
  -- the call. A missing Vault secret is now RAISE LOGged instead of skipped
  -- silently. EXCEPTION handler below still swallows any pg_net failure —
  -- payment integrity is never at risk.
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

  -- 9. gh-916 AC2: progressive partner-status notify, catch-up mode.
  -- Independent BEGIN/EXCEPTION block from step 8 — a failure sending the
  -- partner-status email can never affect the notify-payout-pending call
  -- above, and vice versa. Reuses v_service_role_key if step 8 already
  -- resolved it; re-resolves only if step 8's Vault lookup itself failed.
  BEGIN
    IF v_service_role_key IS NULL THEN
      SELECT decrypted_secret INTO v_service_role_key
        FROM vault.decrypted_secrets
       WHERE name = 'cron_service_role_key';
    END IF;

    IF v_service_role_key IS NULL THEN
      RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping send-partner-status-email for referral_id=%', v_referral.id;
    ELSE
      PERFORM net.http_post(
        url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_role_key
        ),
        body    := jsonb_build_object('referral_id', v_referral.id)
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE LOG 'apply_referral_commission: pg_net call to send-partner-status-email failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
        v_referral.id, SQLSTATE, SQLERRM;
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
'D-180 (v52)/v94/gh-752/gh-916 AC2: On payment_status transition to succeeded (>=$10K job), attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, fires notify-payout-pending via pg_net (Vault-based key), and fires send-partner-status-email catch-up notify via pg_net (gh-916). Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect payment integrity.';

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
