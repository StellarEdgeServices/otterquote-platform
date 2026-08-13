-- v102: fix reverse_referral_commission() to void linked payout_approvals rows
-- on commission reversal (GitHub #651 -- MONEY-OUT).
--
-- reverse_referral_commission() (v42) predates payout_approvals (v52a) and was
-- never updated when v94 landed. On a refund/reversal it correctly zeroed
-- referrals.commission_amount / recruit_commission_amount and walked back
-- recruit_earnings -- but never touched the linked payout_approvals rows,
-- which stayed in 'pending_approval'. The daily process-payout-reminders cron
-- then swept any row matching status = 'pending_approval' AND auto_approve_at
-- < now() into 'auto_approved', paying out real money against a commission
-- already reversed to $0. Confirmed empirically on an isolated Supabase
-- branch (#611).
--
-- Fix: after zeroing the referral ledger, void any 'pending_approval'
-- payout_approvals rows tied to that referral_id by setting them to
-- 'rejected' with an auto-generated rejection_reason -- mirroring the exact
-- column pattern reject-payout/index.ts uses. 'rejected' is an existing valid
-- value in payout_approvals_status_check, so no CHECK constraint change is
-- needed.
--
-- Applied to production 2026-08-09 (Tier 3B / payout-adjacent, D-261,
-- Dustin-approved out-of-band per the ledger-row-per-apply policy). This file
-- captures it in supabase/migrations/ retroactively -- draft authored at
-- sql/v102-fix-reverse-referral-commission-payout-approvals.sql, body below
-- introspected verbatim from production (pg_get_functiondef) to guarantee
-- byte-for-byte parity with what is actually live, not retyped from the
-- draft. CREATE OR REPLACE is idempotent -- reapplying is a no-op.
--
-- Rollback: sql/v102-rollback-fix-reverse-referral-commission-payout-approvals.sql
-- (restores the v42 function body verbatim, pre-fix).

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
  v_voided_count  integer;
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
    RAISE LOG 'reverse_referral_commission: SKIPPING reversal -- commission already paid. quote_id=% claim_id=% referral_id=% commission_amount=% commission_paid_at=% -- FLAGGED FOR MANUAL REVIEW',
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

  UPDATE public.payout_approvals
     SET status            = 'rejected',
         rejected_at       = now(),
         rejection_reason  = 'Auto-voided by reverse_referral_commission: underlying referral commission was reversed/refunded on ' || to_char(now(), 'YYYY-MM-DD') || '.'
   WHERE referral_id = v_referral.id
     AND status = 'pending_approval';
  GET DIAGNOSTICS v_voided_count = ROW_COUNT;

  IF v_voided_count > 0 THEN
    RAISE LOG 'reverse_referral_commission: voided % pending payout_approvals row(s) for referral_id=%',
      v_voided_count, v_referral.id;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'reverse_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$
;
