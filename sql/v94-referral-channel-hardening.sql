-- ============================================================================
-- OtterQuote Referral Channel Hardening Migration
-- ============================================================================
-- Created: 2026-07-24
-- Version: v94
-- Depends on: v36-recruit-system.sql, v40-commission-trigger.sql,
--             v42-commission-reversal-trigger.sql, v49-w9-requirement.sql
--
-- Purpose (GitHub #567, Part 1 — Tier 3B, CEO-approved in-session 2026-07-23,
-- R-097 satisfied):
--
--   1. Widen referral_agents_agent_type_check to admit the two new partner
--      types 'adjuster' and 'other' (partner-adjusters.html /
--      partner-other.html signup surfaces).
--
--   2. Correct the status apply_referral_commission() writes at accrual time.
--      The trigger fires on quotes.payment_status = 'succeeded' — the fee
--      charge at CONTRACT SIGNING — but labeled the referral 'job_completed',
--      which was false (D-139 audit finding #3). Accrual now writes
--      'contract_signed', guarded so a referral already at job_completed or
--      commission_paid is never downgraded. The payout_approvals
--      trigger_event text is corrected to match ('Fee charged — …').
--      Everything else in the function (idempotency, FOR UPDATE, recruit
--      logic, pg_net notify, exception handling) is byte-identical to the
--      production definition captured via pg_get_functiondef on 2026-07-24.
--
-- Companion rollback: v94-rollback-referral-channel-hardening.sql
-- Decisions implemented: D-139 (audit), CEO decisions of 2026-07-23
-- GitHub: #567
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: CONSTRAINT — referral_agents_agent_type_check
-- ============================================================================
-- Prior definition (production, 2026-07-24):
--   CHECK ((agent_type = ANY (ARRAY['re_agent'::text, 'insurance_agent'::text,
--          'home_inspector'::text, 'customer'::text])))
-- ============================================================================

ALTER TABLE public.referral_agents
  DROP CONSTRAINT referral_agents_agent_type_check;

ALTER TABLE public.referral_agents
  ADD CONSTRAINT referral_agents_agent_type_check
  CHECK (agent_type = ANY (ARRAY[
    're_agent'::text,
    'insurance_agent'::text,
    'home_inspector'::text,
    'customer'::text,
    'adjuster'::text,
    'other'::text
  ]));

-- ============================================================================
-- SECTION 2: FUNCTION — apply_referral_commission()
-- ============================================================================
-- Two behavior changes only (both in the referrer-bonus block):
--   * Step 5 status write: 'contract_signed' (was 'job_completed'), guarded
--     against downgrading job_completed / commission_paid.
--   * Referral payout_approvals trigger_event: 'Fee charged — …'
--     (was 'Job completed — …'). The recruit-bonus trigger_event is untouched.
-- ============================================================================

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
  v_supabase_url        TEXT;
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
  --    (#567 / D-139 audit: this trigger fires on the fee charge at contract
  --    signing — the previous 'job_completed' label was false. Never downgrade
  --    a referral that already reached job_completed or commission_paid.)
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
    referral_id,
    payout_type,
    partner_id,
    partner_name,
    amount,
    trigger_event,
    status,
    auto_approve_at
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
      referral_id,
      payout_type,
      partner_id,
      partner_name,
      amount,
      trigger_event,
      status,
      auto_approve_at
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
  --    If pg_net is not available or the call fails, the EXCEPTION handler
  --    below swallows it — payment integrity is never at risk.
  --    The notify-payout-pending function also tolerates duplicate calls
  --    (idempotent via notification_sent_at).
  BEGIN
    v_supabase_url      := current_setting('app.supabase_url',      true);
    v_service_role_key  := current_setting('app.service_role_key',  true);

    IF v_supabase_url IS NOT NULL AND v_service_role_key IS NOT NULL
       AND v_referral_approval IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_supabase_url || '/functions/v1/notify-payout-pending',
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
  -- Never allow a commission-side failure to roll back the payment itself.
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMIT;
