-- ============================================================================
-- v102 — Fix reverse_referral_commission: void linked payout_approvals rows
-- (GitHub #651 — MONEY-OUT)
-- ============================================================================
--
-- PROBLEM
--   reverse_referral_commission() (v42) predates payout_approvals (v52a) and
--   was never updated when v94 landed. On a refund/reversal it correctly
--   zeroes referrals.commission_amount / recruit_commission_amount and walks
--   back recruit_earnings — but it never touches the linked payout_approvals
--   rows, which stay in 'pending_approval'. The daily process-payout-
--   reminders cron sweeps any row matching
--     status = 'pending_approval' AND auto_approve_at < now()
--   into 'auto_approved', then stamps referrals.commission_paid_at — paying
--   out real money against a commission that has already been reversed to
--   $0. Confirmed empirically on an isolated Supabase branch (#611).
--
-- FIX
--   After zeroing the referral ledger, void any 'pending_approval'
--   payout_approvals rows tied to that referral_id by setting them to
--   'rejected' with an auto-generated rejection_reason — mirroring the exact
--   column pattern reject-payout/index.ts uses (status/rejected_at/
--   rejection_reason). 'rejected' is used rather than a new 'voided' status
--   to keep this additive-only: it is already a valid value in
--   payout_approvals_status_check, so no CHECK constraint change is needed.
--   Once status != 'pending_approval', the cron's WHERE clause can never
--   match the row again.
--
-- SCOPE
--   This migration fixes ONLY the primary finding (payout_approvals rows
--   left pending on reversal). The issue's secondary finding — recruit_
--   earnings is credited eagerly at accrual and never decremented by
--   reject-payout on a rejected recruit-tier payout, so a rejected-and-
--   never-reapproved recruit bonus leaves the recruiter's dashboard
--   permanently overstated — is a SEPARATE, lower-severity root cause
--   (manual admin rejection path, not automatic real-money movement) and is
--   NOT addressed here. Flagged for separate Tier C sign-off.
--
-- TIER: 3B / payout-adjacent (D-261). R-097 risk brief required before this
--   ships. DO NOT APPLY TO PRODUCTION FROM THIS SESSION — draft PR only,
--   per the Code lane's explicit boundary on this item.
--
-- Rollback: sql/v102-rollback-fix-reverse-referral-commission-payout-approvals.sql
--   (restores the v42 function body verbatim, pre-fix).
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
  v_voided_count  integer;
BEGIN
  -- 1. Locate the referral via the quote's claim_id. A claim may have at
  --    most one referral attached (see v7 schema), so LIMIT 1 is defensive
  --    rather than necessary. If no referral exists for this claim, there
  --    is nothing to reverse — no-op.
  --
  --    FOR UPDATE locks the row against concurrent writers: the v40 forward
  --    trigger on a sibling quote's UPDATE can race with this reversal if a
  --    homeowner rapidly switches contractors (contract signed -> refunded
  --    -> re-signed). The lock forces serialization.
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE claim_id = NEW.claim_id
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 2. Idempotency: if no commission was ever written (or a prior reversal
  --    already zeroed it), do not re-apply. Matches v40's symmetric guard.
  IF COALESCE(v_referral.commission_amount, 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- 3. Safety rail: never silently reverse a commission that has already
  --    been paid out. The dashboard would lie about what was owed, and the
  --    real money has already left the account. RAISE LOG so the condition
  --    is visible in Supabase logs and Dustin can decide whether to
  --    manually claw back. Return NEW to leave the ledger intact.
  IF v_referral.commission_paid_at IS NOT NULL THEN
    RAISE LOG 'reverse_referral_commission: SKIPPING reversal — commission already paid. quote_id=% claim_id=% referral_id=% commission_amount=% commission_paid_at=% — FLAGGED FOR MANUAL REVIEW',
      NEW.id, NEW.claim_id, v_referral.id,
      v_referral.commission_amount, v_referral.commission_paid_at;
    RETURN NEW;
  END IF;

  -- 4. Capture the recruiter amount BEFORE the UPDATE zeroes it — we need
  --    the value to decrement the running recruit_earnings counter on the
  --    recruiter's referral_agents row. Default to 0 so arithmetic on NULL
  --    never produces NULL.
  v_recruit_amt := COALESCE(v_referral.recruit_commission_amount, 0);

  -- 5. If a recruiter tier was accrued, walk it back on the recruiter's
  --    running total. We load the referrer to get recruited_by_id — the
  --    recruiter's referral_agents row — then decrement by exactly the
  --    amount that was credited on the forward path (v40 writes $50;
  --    this decrements whatever was written, not a hardcoded $50, so the
  --    reversal stays correct if the amount ever changes). GREATEST(..., 0)
  --    guards against a NULL or negative running total turning into an
  --    implausible negative balance.
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

  -- 6. Zero the referral ledger and step the status back from 'job_completed'
  --    to 'contract_signed' (the pre-completion state per the v7 enum:
  --    clicked -> registered -> claim_submitted -> bid_received ->
  --    contract_signed -> job_completed -> commission_paid). Guard the
  --    status reset with a CASE so we never walk back from a state that
  --    wasn't 'job_completed' in the first place — e.g., if a row was
  --    manually reconciled to some other state, leave it alone.
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

  -- 7. NEW (v102/#651) — void any pending_approval payout_approvals rows
  --    tied to this referral. Without this, process-payout-reminders'
  --    auto-approve sweep (status='pending_approval' AND auto_approve_at <
  --    now()) would still match these rows even though the referral they're
  --    tied to now has a $0 commission, and would pay out real money.
  --    'rejected' (not a new 'voided' status) — already a valid
  --    payout_approvals_status_check value, keeping this additive-only.
  --    Column pattern matches reject-payout/index.ts exactly.
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
  -- Never allow a reversal-side failure to roll back the refund itself.
  -- Refund integrity is primary; ledger accrual is best-effort and can be
  -- reconciled manually. Emit a Postgres LOG entry so the failure is
  -- visible in Supabase logs. Mirrors v40's exception handler exactly.
  WHEN OTHERS THEN
    RAISE LOG 'reverse_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.reverse_referral_commission() IS
'v102/#651: on reversal, zeroes the referral ledger AND voids any pending_approval payout_approvals rows tied to it (status=rejected, auto-generated reason) so process-payout-reminders'' auto-approve sweep can never pay out a reversed commission. Previously (v42) only touched referrals/referral_agents, leaving payout_approvals rows pending — a confirmed real-money exposure (#611/#651).';

COMMIT;
