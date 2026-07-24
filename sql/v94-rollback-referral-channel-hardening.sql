-- ============================================================================
-- OtterQuote Referral Channel Hardening — ROLLBACK
-- ============================================================================
-- Created: 2026-07-24
-- Version: v94 rollback (companion to v94-referral-channel-hardening.sql)
--
-- Restores:
--   1. The original referral_agents_agent_type_check (4 types — no
--      'adjuster' / 'other').
--   2. The original apply_referral_commission() definition, captured VERBATIM
--      from production via pg_get_functiondef on 2026-07-24 BEFORE v94 was
--      authored.
--
-- ⚠️  PRECONDITION — READ BEFORE RUNNING:
--   The constraint re-add below will FAIL with a check violation if any
--   referral_agents rows carry agent_type IN ('adjuster', 'other'). Those
--   rows must be reviewed and dispositioned FIRST. This file deliberately
--   does NOT auto-delete them — removing partner accounts is a Tier 3 human
--   decision. If (and only if) Dustin has approved removal, the guarded shape
--   is:
--
--     -- Review first:
--     -- SELECT id, email, agent_type, created_at
--     --   FROM public.referral_agents
--     --  WHERE agent_type IN ('adjuster', 'other');
--     -- Then, only with explicit approval:
--     -- DELETE FROM public.referral_agents
--     --  WHERE agent_type IN ('adjuster', 'other');
--
-- GitHub: #567
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: CONSTRAINT — restore original 4-type check
-- ============================================================================

ALTER TABLE public.referral_agents
  DROP CONSTRAINT referral_agents_agent_type_check;

ALTER TABLE public.referral_agents
  ADD CONSTRAINT referral_agents_agent_type_check
  CHECK (agent_type = ANY (ARRAY[
    're_agent'::text,
    'insurance_agent'::text,
    'home_inspector'::text,
    'customer'::text
  ]));

-- ============================================================================
-- SECTION 2: FUNCTION — restore original apply_referral_commission()
-- ============================================================================
-- Verbatim production definition (pg_get_functiondef, 2026-07-24, pre-v94).
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

  -- 5. Apply the $200 referrer bonus and advance status to 'job_completed'.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
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
    'Job completed — referral ' || v_referral.id::TEXT || ' (quote ' || NEW.id::TEXT || ')',
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
