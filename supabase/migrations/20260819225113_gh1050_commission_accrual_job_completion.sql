-- gh-1050: D-283 code half — commission accrual, deposit success -> job completion
-- Tier 3B (D-182). R-097 24h notice window opened 2026-08-14T16:44:53Z, closed
-- 2026-08-15T16:44:53Z with no objection. Execution authorized by Bridge answer
-- A3 on #1053 (comment 2026-08-19T22:20:06Z), which also required this migration
-- be rebased against gh-916's now-live apply_referral_commission() body before
-- applying, and required a fresh live blast-radius re-verification at apply time
-- (not the ~20:56Z branch-test figures from the original draft).
--
-- Applied to production yeszghaspzwwstvsrioa via apply_migration 2026-08-19
-- (session rw-1050-f22-apply2). This repo file is added post-apply to keep a
-- trace, matching the gh-752/gh-886/gh-916 precedent -- merging this PR does
-- NOT (re-)apply the migration, it already ran.
--
-- Drafted 2026-08-19 (session rw-1050-f22-b6cm, PR #1060) as
-- supabase/migrations_drafts/gh1050_commission_accrual_job_completion.sql,
-- against the body of apply_referral_commission() as it existed BEFORE gh-916
-- applied. gh-916 (PR #1062) applied to production first and appended a new,
-- independently-BEGIN/EXCEPTION-wrapped "step 9" send-partner-status-email
-- pg_net call to the end of the same function. This session (rw-1050-f22-apply2)
-- rebased the draft: refetched the live post-gh-916 function body via
-- pg_get_functiondef, confirmed gh-916's addition was purely additive/appendable
-- (no overlap with gh-1050's changes to the referral-resolution, floor-check,
-- commission-write, payout_approvals-insert, or notify-payout-pending logic),
-- and carried gh-916's step forward verbatim as step 10 on top of gh-1050's
-- claims-retargeted body. Full section-by-section comparison plus a live branch
-- test (branch gh1050-rebase-verify, synced to post-gh-916 state first, then the
-- rebased migration applied on top) reproduced all 4 of the original draft's
-- assertions unchanged and confirmed the new step-10 send-partner-status-email
-- call fires without disturbing the accrual write. Branch deleted after use.
--
-- Live blast-radius re-verification immediately before this migration applied
-- (2026-08-19T22:5x, this session, NOT the ~20:56Z figures from the original
-- draft): payout_approvals = 0 rows, total_commission_paid = $0.00,
-- total_commission_earned = $0.00 across all referral_agents, referrals with
-- commission_amount > 0 = 0 (of 8 total), quotes with payment_status='succeeded'
-- = 0. Risk profile as originally described in #1050 -- unchanged, still
-- near-zero.
--
-- Summary: moves commission accrual from firing on quotes.payment_status
-- transitioning to 'succeeded' (the platform-fee ACH charge finalizing at
-- CONTRACT SIGNING, per the stripe-webhook gh-948 routing comment) to firing on
-- claims.completion_date transitioning from NULL to set (JOB COMPLETION,
-- currently the mark-job-complete Edge Function's sole write path). Every
-- partner-facing surface (Partner Referral Agreement Sec 4.2, partner-re.html,
-- partner-dashboard.html) already states commissions are owed once the job is
-- done; the code owed it at deposit. This is the code half of D-283 (locked
-- 2026-08-14); the contract half (offset-only reversal, no cash-repayment
-- demand) becomes operationally real only once this lands.
--
-- apply_referral_commission() is retargeted from a quotes row to a claims row:
-- referral_id is read directly off claims (simpler than the old
-- claims-lookup-via-quotes.claim_id indirection), and the $10K qualifying-job
-- floor (D-139) plus job_value are resolved from the winning quote
-- (status IN ('selected','awarded'), the same predicate mark-job-complete
-- itself uses) inside the function body, since a trigger WHEN clause on claims
-- cannot reference quotes columns.
--
-- Post-apply live verification (rw-1050-f22-apply2, 2026-08-19):
--   - pg_get_triggerdef confirms after_quote_paid is gone; after_claim_completed
--     exists on public.claims, enabled, WHEN NEW.completion_date IS NOT NULL AND
--     OLD.completion_date IS NULL.
--   - pg_get_functiondef on apply_referral_commission() shows BOTH gh-916's step
--     (send-partner-status-email) and gh-1050's claims-retarget verbatim.
--   - Smoke, zero real-partner impact, against the designated E2E TEST CLAIM
--     (claim_id 8dcf76f1-f518-4363-a37f-192dec10b9bb, referral_id
--     ea75db9f-0f49-4aec-aaa4-45cc82ef7aa3, agent email
--     dustinstohler1+jjdemo0805@gmail.com -- Dustin's own test inbox):
--       1. Set the test quote's payment_status to 'succeeded' -- confirmed NO
--          accrual (referrals.commission_amount stayed NULL, payout_approvals
--          rows = 0). The old deposit-success firing point is gone.
--       2. Set claims.completion_date -- confirmed exactly ONE accrual:
--          referrals.commission_amount = 200.00, job_value = 15000.00,
--          status = 'job_completed', payout_approvals = 1 row
--          (trigger_event = 'Job completed -- referral ea75db9f... (claim
--          8dcf76f1...)'). net._http_response shows the new step-10
--          send-partner-status-email call succeeded (200, stage 5 sent,
--          real Mailgun send); the step-9 notify-payout-pending call timed out
--          (non-fatal by design -- swallowed by its own BEGIN/EXCEPTION block,
--          did not affect the accrual write, which committed successfully
--          regardless).
--
-- Rollback: supabase/migrations_rollbacks/gh1050_commission_accrual_job_completion_rollback.sql
-- Draft history: supabase/migrations_drafts/gh1050_commission_accrual_job_completion.sql (rebased)
-- GitHub: #1050 (D-283 code half)

BEGIN;

DROP TRIGGER IF EXISTS after_quote_paid ON public.quotes;

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
  --    directly on claims -- no join through quotes.claim_id needed anymore.
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
  --    interim 'contract_signed' label v94 introduced no longer applies --
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
  --    Vault-based key resolution -- matches the LIVE gh-752 (2026-08-17)
  --    body. Non-fatal -- failure here never affects the accrual write above.
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
  --     block from step 9 -- a failure sending the partner-status email can
  --     never affect the notify-payout-pending call above, and vice versa.
  --     Reuses v_service_role_key if step 9 already resolved it; re-resolves
  --     only if step 9's Vault lookup itself failed. References v_referral.id
  --     -- unchanged meaning under gh-1050's retarget, since v_referral is
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
