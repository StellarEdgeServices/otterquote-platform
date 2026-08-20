-- ============================================================================
-- gh1050_commission_accrual_job_completion — Forward migration (REBASED)
-- ============================================================================
-- D-283 code half (GitHub #1050). R-097 24h notice window opened
-- 2026-08-14T16:44:53Z, closed 2026-08-15T16:44:53Z with no objection.
-- Execution permitted. Bridge answer A3 on #1053 (comment 2026-08-19T22:20:06Z)
-- reconfirmed execution is authorized and required this rebase before apply.
--
-- REBASE NOTE (2026-08-19, this session, rw-1050-f22-apply2)
--   The original draft (session rw-1050-f22-b6cm, 2026-08-19T20:56Z) was
--   written against the PRE-gh-916 body of apply_referral_commission().
--   gh-916's own migration (20260819210920_gh916_progressive_partner_status_
--   triggers, repo-tracked as supabase/migrations/20260819211149_gh916_
--   progressive_partner_status_triggers.sql, PR #1062) applied to production
--   BEFORE this migration and appended a new, independently-BEGIN/EXCEPTION-
--   wrapped "step 9" send-partner-status-email pg_net call to the end of
--   apply_referral_commission() — strictly after the existing step 8
--   (notify-payout-pending) call, before RETURN NEW. Verified byte-for-byte
--   via pg_get_functiondef('public.apply_referral_commission()'::regprocedure)
--   against production yeszghaspzwwstvsrioa (this session) and against
--   supabase/migrations/20260819211149_gh916_progressive_partner_status_
--   triggers.sql on origin/main: identical. gh-916's addition is purely
--   additive/appendable and does not touch the commission math, the
--   payout_approvals insert, the recruit-bonus block, or the notify-payout-
--   pending block gh-1050 already carries — so this rebase carries gh-916's
--   step 9 forward VERBATIM as a new step 10, on top of gh-1050's claims-
--   retargeted body, with no other change to either side's logic.
--
-- PROBLEM
--   apply_referral_commission() currently fires on the trigger
--   after_quote_paid (AFTER UPDATE OF payment_status ON quotes, WHEN
--   NEW.payment_status = 'succeeded' AND total_price >= $10,000). Per the
--   stripe-webhook gh-948 routing comment, that transition is written by the
--   platform-fee ACH charge finalizing at CONTRACT SIGNING — i.e. before any
--   contracted work has happened. Every partner-facing surface (Partner
--   Referral Agreement Sec 4.2, partner-re.html, partner-dashboard.html)
--   already says the commission is owed once the job is done. The gap this
--   migration closes: the commission ledger entry (referrals.commission_amount
--   + a payout_approvals row) is created before completion, not after.
--
-- COMPLETION SIGNAL CHOSEN — claims.completion_date, via a DB trigger
--   Confirmed (2026-08-19) that claims.completion_date has exactly ONE write
--   path in the live codebase: the mark-job-complete Edge Function
--   (supabase/functions/mark-job-complete/index.ts). It is contractor-
--   authenticated, requires the claim to be in ('contract_signed',
--   'awarded'), and is itself idempotent. No other Edge Function, trigger,
--   or admin surface sets this column.
--
--   A DB trigger (not an explicit call inside mark-job-complete) matches this
--   repo's existing pattern (after_quote_paid / after_quote_refunded /
--   trg_claims_advance_referral are all triggers-on-event) and gets ACID
--   guarantees for free in the same transaction as the completion_date write.
--
-- WHAT THIS MIGRATION DOES
--   1. Drops after_quote_paid (the old quotes.payment_status='succeeded'
--      firing point).
--   2. Replaces apply_referral_commission() so it operates on a claims row
--      instead of a quotes row: NEW.referral_id (direct FK on claims)
--      resolves the referral directly; the $10K qualifying-job floor
--      (D-139) and job_value now come from the winning quote (status IN
--      ('selected','awarded')) looked up inside the function body, since a
--      trigger WHEN clause on claims cannot reference quotes columns.
--      Carries gh-916's step 9 (send-partner-status-email catch-up notify)
--      forward verbatim as step 10, after gh-1050's own notify-payout-
--      pending call. All other steps otherwise unchanged from the live body
--      captured via pg_get_functiondef() on 2026-08-19 (post-gh-916).
--   3. Creates after_claim_completed (AFTER UPDATE OF completion_date ON
--      claims, WHEN NEW.completion_date IS NOT NULL AND OLD.completion_date
--      IS NULL) to replace after_quote_paid as the sole firing point.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH
--   - reverse_referral_commission() / after_quote_refunded (v42/v102):
--     unaffected — operates purely on referrals' current ledger state.
--   - approve-payout's existing completion gate (D-139/#567): unaffected —
--     already holds payout RELEASE on completion_date IS NULL.
--   - mark-job-complete's own non-fatal referrals.status='job_completed'
--     advance write: unaffected, still idempotent, now a no-op in the
--     common case since the new trigger sets the same status first.
--   - claims_advance_referral() and notify_partner_status_on_bid_submitted()
--     (gh-916 sites 1 and 2): untouched by this migration — gh-1050 only
--     ever modified apply_referral_commission() and its two triggers.
--
-- Rollback: gh1050_commission_accrual_job_completion_rollback.sql (rebased
--   to restore the live post-gh-916, pre-gh-1050 body verbatim).
-- Pre-flight: gh1050_commission_accrual_job_completion_pre-flight.md
-- GitHub: #1050 (D-283 code half)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: DROP the old deposit-success firing point
-- ============================================================================
DROP TRIGGER IF EXISTS after_quote_paid ON public.quotes;

-- ============================================================================
-- SECTION 2: FUNCTION — apply_referral_commission() retargeted to claims,
--            carrying gh-916's step 9 (send-partner-status-email) forward
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_service_role_key    TEXT;
  v_quote_id            UUID;
  v_total_price         NUMERIC;
BEGIN
  -- 1. gh-1050: NEW is now a claims row (trigger moved from
  --    quotes.payment_status to claims.completion_date). referral_id lives
  --    directly on claims — no join through quotes.claim_id needed anymore.
  IF NEW.referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 2. Load and lock the referral row.
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = NEW.referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 3. Idempotency: if commission was already applied, do not re-apply.
  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- 4. gh-1050: resolve the winning quote's total_price. The $10K
  --    qualifying-job floor (D-139) lived in the old trigger's WHEN clause
  --    (quotes.total_price >= 10000); a WHEN clause on claims cannot
  --    reference quotes columns, so the floor check moves in here. Same
  --    ownership predicate mark-job-complete itself uses to find the won
  --    quote (status IN ('selected','awarded')).
  SELECT id, total_price INTO v_quote_id, v_total_price
    FROM public.quotes
    WHERE claim_id = NEW.id
      AND status IN ('selected', 'awarded')
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1;

  IF v_quote_id IS NULL OR COALESCE(v_total_price, 0) < 10000 THEN
    RETURN NEW;
  END IF;

  -- 5. Load the referrer.
  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 6. Apply the $200 referrer bonus and advance status to 'job_completed'.
  --    gh-1050: this function now only ever runs AT completion, so the
  --    interim 'contract_signed' label v94 introduced no longer applies —
  --    accrual IS completion now. Guard only against 'commission_paid' so a
  --    manually-reconciled row is never walked backward.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = v_total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
                             END
   WHERE id = v_referral.id;

  -- 7. Insert payout_approval for the referral commission.
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
    'Job completed — referral ' || v_referral.id::TEXT || ' (claim ' || NEW.id::TEXT || ')',
    'pending_approval',
    NOW() + INTERVAL '7 days'
  )
  RETURNING id INTO v_referral_approval;

  -- 8. Forward-only recruit bonus per D-142. Unchanged from the live body.
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

  -- 9. Fire notify-payout-pending via pg_net (async, fire-and-forget).
  --    Vault-based key resolution — matches the LIVE gh-752 (2026-08-17)
  --    body. Non-fatal — failure here never affects the accrual write above.
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

  -- 10. gh-916 AC2 (carried forward verbatim by this rebase): progressive
  --     partner-status notify, catch-up mode. Independent BEGIN/EXCEPTION
  --     block from step 9 — a failure sending the partner-status email can
  --     never affect the notify-payout-pending call above, and vice versa.
  --     Reuses v_service_role_key if step 9 already resolved it; re-resolves
  --     only if step 9's Vault lookup itself failed. References v_referral.id
  --     — unchanged meaning under gh-1050's retarget, since v_referral is
  --     still loaded (and still the same row) in step 2 above.
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
  -- Never allow a commission-side failure to roll back the completion write
  -- itself. Completion integrity is primary; commission accrual is
  -- best-effort and can be reconciled manually. gh-1050: NEW is a claims
  -- row here, so the diagnostic references NEW.id / NEW.referral_id (not
  -- NEW.claim_id, which does not exist on this row type).
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'gh-1050/D-283 + gh-916 AC2 (rebased 2026-08-19): retargeted from quotes.payment_status=succeeded (deposit/fee-charge success at contract signing) to claims.completion_date being set (job completion — currently sole write path: mark-job-complete Edge Function). On the transition, resolves the claim''s referral directly via claims.referral_id, floor-checks the winning quote''s total_price >= $10K, attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, fires notify-payout-pending via pg_net (Vault-based key, gh-752 pattern), and fires send-partner-status-email catch-up notify via pg_net (gh-916 AC2, carried forward unchanged by this rebase). Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect the completion write.';

-- ============================================================================
-- SECTION 3: TRIGGER — after_claim_completed (new accrual firing point)
-- ============================================================================
DROP TRIGGER IF EXISTS after_claim_completed ON public.claims;

CREATE TRIGGER after_claim_completed
  AFTER UPDATE OF completion_date ON public.claims
  FOR EACH ROW
  WHEN (
    NEW.completion_date IS NOT NULL
    AND OLD.completion_date IS NULL
  )
  EXECUTE FUNCTION public.apply_referral_commission();

COMMENT ON TRIGGER after_claim_completed ON public.claims IS
'gh-1050/D-283: fires apply_referral_commission() once, on the transition of claims.completion_date from NULL to a value — i.e. job completion (currently the mark-job-complete Edge Function''s sole write path). Supersedes after_quote_paid (dropped by this same migration), which fired too early, on the homeowner/platform-fee deposit success at contract signing.';

COMMIT;

-- ============================================================================
-- SECTION 4: VERIFICATION QUERIES (run after apply)
-- ============================================================================
-- 4a. Confirm the old trigger is gone and the new one exists.
SELECT tgname, tgrelid::regclass AS table_name, tgenabled, pg_get_triggerdef(oid) AS def
FROM pg_trigger
WHERE tgname IN ('after_quote_paid', 'after_claim_completed');

-- 4b. Confirm the function is SECURITY DEFINER and matches expectations.
SELECT p.proname, p.prosecdef
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'apply_referral_commission';

-- ============================================================================
-- End of Migration gh1050_commission_accrual_job_completion (rebased)
-- ============================================================================
