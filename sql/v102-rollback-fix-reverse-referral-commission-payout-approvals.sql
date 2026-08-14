-- ============================================================================
-- v102 ROLLBACK — restores reverse_referral_commission() to its pre-fix (v42)
-- body verbatim (GitHub #651)
-- ============================================================================
--
-- Does NOT un-void any payout_approvals rows this function already voided
-- while the fix was live — that would resurrect a pending_approval row
-- against a $0 commission, exactly the bug this migration fixes. If a
-- genuine rollback is needed after the fix has run in production, any
-- voided rows requiring manual reconsideration must be reviewed individually
-- by an admin, not bulk-reverted by this script.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reverse_referral_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral      public.referrals%ROWTYPE;
  v_referrer      public.referral_agents%ROWTYPE;
  v_recruit_amt   DECIMAL(10,2);
BEGIN
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE claim_id = NEW.claim_id
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF v_referral.commission_paid_at IS NOT NULL THEN
    RAISE LOG 'reverse_referral_commission: SKIPPING reversal — commission already paid. quote_id=% claim_id=% referral_id=% commission_amount=% commission_paid_at=% — FLAGGED FOR MANUAL REVIEW',
      NEW.id, NEW.claim_id, v_referral.id,
      v_referral.commission_amount, v_referral.commission_paid_at;
    RETURN NEW;
  END IF;

  v_recruit_amt := COALESCE(v_referral.recruit_commission_amount, 0);

  IF v_recruit_amt > 0 THEN
    SELECT * INTO v_referrer
      FROM public.referral_agents
      WHERE id = v_referral.referral_agent_id;

    IF FOUND AND v_referrer.recruited_by_id IS NOT NULL THEN
      UPDATE public.referral_agents
         SET recruit_earnings = GREATEST(COALESCE(recruit_earnings, 0) - v_recruit_amt, 0)
       WHERE id = v_referrer.recruited_by_id;
    END IF;
  END IF;

  UPDATE public.referrals
     SET commission_amount         = 0,
         recruit_commission_amount = 0,
         job_value                 = NULL,
         status                    = CASE
                                        WHEN status = 'job_completed'
                                          THEN 'contract_signed'
                                        ELSE status
                                      END
   WHERE id = v_referral.id;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'reverse_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMIT;
