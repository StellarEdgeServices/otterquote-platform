-- ============================================================================
-- gh1050_commission_accrual_job_completion — Forward migration
-- ============================================================================
-- D-283 code half (GitHub #1050). R-097 24h notice window opened
-- 2026-08-14T16:44:53Z, closed 2026-08-15T16:44:53Z with no objection.
-- Execution permitted; still requires a normal D-182 migration approval
-- before this applies to production (yeszghaspzwwstvsrioa).
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
--   Confirmed (2026-08-19, this session) that claims.completion_date has
--   exactly ONE write path in the live codebase: the mark-job-complete Edge
--   Function (supabase/functions/mark-job-complete/index.ts). It is
--   contractor-authenticated, requires the claim to be in
--   ('contract_signed', 'awarded'), and is itself idempotent (a second call
--   returns the existing timestamp with already_complete:true, no second
--   write). No other Edge Function, trigger, or admin surface sets this
--   column — grepped the full supabase/functions tree and sql/*.sql for
--   "completion_date" writers; mark-job-complete is the only one.
--
--   Chose a DB trigger (not an explicit call added inside mark-job-complete)
--   for the same reason v40's original header gives for using a trigger over
--   a scheduled function: this is an event ("a job was marked complete"),
--   not a time-series job, and a trigger gets ACID guarantees for free in
--   the same transaction as the completion_date write, with no dependency on
--   every future code path that might set completion_date remembering to
--   also call the accrual logic. This repo's own existing pattern
--   (after_quote_paid / after_quote_refunded / trg_claims_advance_referral)
--   is triggers-on-event throughout the referral/commission subsystem — this
--   keeps the design consistent with it rather than introducing a one-off
--   EF-level call as the sole accrual site.
--
-- WHAT THIS MIGRATION DOES
--   1. Drops after_quote_paid (the old quotes.payment_status='succeeded'
--      firing point).
--   2. Replaces apply_referral_commission() so it operates on a claims row
--      instead of a quotes row: NEW.referral_id (direct FK on claims, no
--      join needed — simpler than the old claims-lookup-via-quotes.claim_id
--      indirection) resolves the referral directly; the $10K qualifying-job
--      floor (D-139) and job_value now come from the winning quote
--      (status IN ('selected','awarded'), same ownership predicate
--      mark-job-complete itself uses) looked up inside the function body,
--      since a trigger WHEN clause on claims cannot reference quotes
--      columns. Steps 6-9 (payout_approvals insert, recruit bonus,
--      notify-payout-pending via the live Vault-based pg_net pattern) are
--      otherwise unchanged from the live body captured via
--      pg_get_functiondef() on 2026-08-19.
--   3. Creates after_claim_completed (AFTER UPDATE OF completion_date ON
--      claims, WHEN NEW.completion_date IS NOT NULL AND OLD.completion_date
--      IS NULL) to replace after_quote_paid as the sole firing point.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH
--   - reverse_referral_commission() / after_quote_refunded (v42/v102): still
--     fires on quotes.payment_status -> 'refunded' and still reverses
--     referrals.commission_amount + voids pending payout_approvals rows.
--     Unaffected by where accrual happens — it only cares about referrals'
--     current ledger state. A refund on a claim that never completed is now
--     simply a no-op here (commission_amount was never written), same as
--     today's floor-miss no-op.
--   - approve-payout's existing completion gate (D-139/#567): already reads
--     claims.completion_date at payout-RELEASE time and holds unless an
--     admin explicitly overrides. That gate stays; this migration fixes the
--     earlier problem of the ledger ENTRY existing at all before completion.
--   - mark-job-complete's own non-fatal `referrals.status = 'job_completed'`
--     advance write: still runs, still idempotent (guarded by
--     `.not("status","in",'("job_completed","commission_paid")')`), and is
--     now a no-op in the common case because the trigger in this migration
--     already sets that same status inside the same DB transaction as the
--     completion_date UPDATE, before mark-job-complete's later separate
--     round-trip runs.
--
-- KNOWN COORDINATION ITEM — gh916 (unrelated, unapplied draft)
--   supabase/migrations_drafts/gh916_progressive_partner_status_triggers.sql
--   also modifies apply_referral_commission() (adds a step 9 partner-status
--   pg_net call), but is still itself an unapplied D-182-pending draft as of
--   2026-08-19 and was written against the OLD quotes-triggered body. If
--   gh916 is approved and applied to production BEFORE this migration, this
--   migration's CREATE OR REPLACE FUNCTION will silently drop gh916's step 9
--   addition (it fully replaces the function body). Flagged on the PR and
--   issue #1050 — whichever of gh916 / gh1050 applies second must be rebased
--   against the other's live function body before applying.
--
-- Rollback: gh1050_commission_accrual_job_completion_rollback.sql
-- Pre-flight: gh1050_commission_accrual_job_completion_pre-flight.md
-- GitHub: #1050 (D-283 code half)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: DROP the old deposit-success firing point
-- ============================================================================
DROP TRIGGER IF EXISTS after_quote_paid ON public.quotes;

-- ============================================================================
-- SECTION 2: FUNCTION — apply_referral_commission() retargeted to claims
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
  --    body, not the stale app.* GUC pattern in sql/v94-referral-channel-
  --    hardening.sql. Non-fatal — failure here never affects the accrual
  --    write above.
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
  -- Never allow a commission-side failure to roll back the completion write
  -- itself. Completion integrity is primary; commission accrual is
  -- best-effort and can be reconciled manually.
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'gh-1050/D-283 (v103): retargeted from quotes.payment_status=succeeded (deposit/fee-charge success at contract signing) to claims.completion_date being set (job completion — currently sole write path: mark-job-complete Edge Function). On the transition, resolves the claim''s referral directly via claims.referral_id, floor-checks the winning quote''s total_price >= $10K, attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, and fires notify-payout-pending via pg_net (Vault-based key, gh-752 pattern). Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect the completion write.';

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
-- End of Migration gh1050_commission_accrual_job_completion
-- ============================================================================
