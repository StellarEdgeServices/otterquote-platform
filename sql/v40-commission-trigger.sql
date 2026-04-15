-- ============================================================================
-- OtterQuote Commission Trigger Migration
-- ============================================================================
-- Created: 2026-04-15
-- Version: v40
-- Depends on: v7-referral-system.sql, v31-payment-dunning.sql, v36-recruit-system.sql
--
-- Purpose:
--   Closes Gap A flagged in Session 181's Handoff — the backend commission
--   math described in D-139 through D-142 was documented and exercised in
--   tests/smoke-tests.mjs but never actually wired into the database. This
--   migration introduces the first and only writer of referrals.commission_amount
--   and referrals.recruit_commission_amount.
--
-- Design — trigger, not scheduled Edge Function:
--   Commission accrual is an event ("a qualifying job was paid"), not a
--   time-series job. A trigger runs inside the same transaction as the
--   payment update, gets ACID guarantees for free, and has no cron drift,
--   no missed-window risk, and no separate deployment surface. The existing
--   update_referral_stats trigger (v7) already uses this pattern — we follow
--   suit. A scheduled Edge Function would either (a) duplicate work on every
--   run or (b) require its own cursor column. Not worth the complexity.
--
-- Semantics note — "payment_status = 'succeeded'" fires on the homeowner's
--   initial payment success (per v31 dunning system), which in practice is
--   the deductible deposit after contract signing. D-139 states commissions
--   are "paid on job completion." This migration sets commission AMOUNTS
--   (what is OWED) at deposit-success time. Actual PAYOUTS — toggling
--   commission_paid_at / recruit_paid_at — remain a downstream manual step
--   gated on real job completion. If a job later cancels (D-025), the rebate
--   path must clear these amounts; that is a separate follow-up task.
--
-- Task-prompt name corrections (applied in this file):
--   * Column is `quotes.total_price`, not `total_amount` (no such column
--     exists in quotes — verified against information_schema on 2026-04-15).
--   * Success value is `'succeeded'`, not `'paid'` — per the
--     quotes_payment_status_check constraint (see v31 and v37).
--
-- Decisions implemented: D-139, D-140, D-141, D-142
-- ClickUp: 86e0xdy9h
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: FUNCTION — apply_referral_commission()
-- ============================================================================
-- Runs inside the quote-payment transaction. Locates the referral row through
-- the claim, attributes the $200 referrer bonus, and — when the referrer was
-- themselves recruited forward-only per D-142 — attributes the $50 recruiter
-- bonus. Idempotent: if a commission has already been set on the referral,
-- the function no-ops.
--
-- SECURITY DEFINER so the function can update referrals / referral_agents
-- even when the caller (the payment path) runs under an end-user JWT that
-- would otherwise be blocked by the referrals / referral_agents RLS policies.
-- search_path is pinned to prevent search_path-based privilege escalation.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claim_referral_id UUID;
  v_referral          public.referrals%ROWTYPE;
  v_referrer          public.referral_agents%ROWTYPE;
BEGIN
  -- 1. Locate the referral via the quote's claim. If no claim row, or the
  --    claim has no referral attached, there is nothing to do.
  SELECT referral_id INTO v_claim_referral_id
    FROM public.claims
    WHERE id = NEW.claim_id;

  IF v_claim_referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 2. Load the referral row, locking it against concurrent commission
  --    writes (defense-in-depth — the WHEN clause on the trigger already
  --    prevents re-fire on the same transition, but a race between two
  --    simultaneously-paid quotes on the same claim is theoretically
  --    possible).
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = v_claim_referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 3. Idempotency: if commission was already applied (e.g., by a manual
  --    back-fill or a prior successful trigger run), do not re-apply.
  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- 4. Load the referrer for recruit-attribution lookup. A referral row
  --    with no referral_agent is malformed — skip silently, do not raise.
  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 5. Apply the $200 referrer bonus. Record job value from the quote and
  --    advance status to 'job_completed' unless the referral has already
  --    transitioned to 'commission_paid' (defensive — prevents walking
  --    backward through the funnel if the row was manually reconciled).
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
                             END
   WHERE id = v_referral.id;

  -- 6. Forward-only recruit bonus per D-142. Three conditions:
  --      (a) the referrer was recruited (recruited_by_id IS NOT NULL),
  --      (b) the recruitment relationship has a timestamp, and
  --      (c) the referral was created at or after the recruitment — no
  --          retroactive credit for referrals that predate the link.
  --
  --    The recruiter's running recruit_earnings counter is incremented
  --    in the same statement as the referrals update to keep them in sync.
  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at   >= v_referrer.recruited_at THEN

    UPDATE public.referrals
       SET recruit_commission_amount = 50
     WHERE id = v_referral.id;

    UPDATE public.referral_agents
       SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
     WHERE id = v_referrer.recruited_by_id;
  END IF;

  RETURN NEW;

EXCEPTION
  -- Never allow a commission-side failure to roll back the payment itself.
  -- Payment integrity is primary; commission accrual is best-effort and can
  -- be reconciled manually. Emit a Postgres LOG entry so the failure is
  -- visible in Supabase logs. We intentionally do NOT write to activity_log
  -- because that table requires a NOT NULL user_id and we don't have a
  -- system-actor UUID to use in this context.
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'Trigger function attached to quotes AFTER UPDATE OF payment_status. On the transition NEW.payment_status=''succeeded'' with total_price >= $10,000, attributes $200 to referrer and, when forward-only criteria (D-142) pass, $50 to recruiter. Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all commission-side errors are swallowed and logged to activity_log to protect payment integrity.';

-- ============================================================================
-- SECTION 2: TRIGGER — after_quote_paid
-- ============================================================================
-- Fires exactly once per quote on the payment_status transition to
-- 'succeeded'. The WHEN clause is the full gate:
--   * NEW.payment_status = 'succeeded'  — only on success, not pending/failed
--   * OLD IS DISTINCT FROM 'succeeded'  — only on the transition INTO succeeded,
--                                         never on a same-state update
--   * total_price >= 10000              — D-139 qualifying-job floor
--
-- Using AFTER UPDATE OF payment_status restricts the trigger to updates that
-- actually touch payment_status, which avoids evaluating the WHEN clause on
-- every unrelated quote mutation.
-- ============================================================================
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
'Fires once per quote when payment_status transitions to succeeded on a job >= $10K. Entry point for D-139/D-140/D-141/D-142 commission accrual. See apply_referral_commission().';

COMMIT;

-- ============================================================================
-- SECTION 3: VERIFICATION QUERIES
-- ============================================================================
-- 3a. Confirm the function exists and is SECURITY DEFINER.
SELECT
  n.nspname               AS schema,
  p.proname               AS function_name,
  p.prosecdef             AS is_security_definer,
  pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'apply_referral_commission';

-- 3b. Confirm the trigger exists and is attached to quotes.
SELECT
  tgname              AS trigger_name,
  tgrelid::regclass   AS table_name,
  tgenabled           AS enabled,
  pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'after_quote_paid';

-- ============================================================================
-- End of Migration v40 — Commission Trigger
-- ============================================================================
