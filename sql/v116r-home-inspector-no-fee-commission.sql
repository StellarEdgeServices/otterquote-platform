-- ============================================================================
-- v116 ROLLBACK — Home Inspector partners: no referral fee, no recruit bonus
-- ============================================================================
-- Restores public.apply_referral_commission() to the definition verified LIVE
-- on production 2026-09-24 via:
--   SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public' AND p.proname='apply_referral_commission';
-- (the trigger after_claim_completed on public.claims is untouched by v116
-- and needs no rollback of its own).
--
-- FIXUP 2026-09-24 (review comment 5817579721 on PR #2158, must-fix 3):
--   The function body below is byte-for-byte the live pre-v116 body —
--   verified inside BEGIN...ROLLBACK by comparing
--   md5(pg_get_functiondef('public.apply_referral_commission'::regproc))
--   of the live function against the result of running this exact rollback
--   body (both = 69ae9b33b40652bb4984aeaacb264213; see PR comment for the
--   paste). What was wrong in the prior version of this file was the
--   COMMENT ON FUNCTION text: it restored the STALE v40 description
--   ("Trigger function attached to quotes AFTER UPDATE OF payment_status
--   ... D-142 ..."), not the description actually live on production today
--   (gh-1050/D-283, rebased 2026-08-19, describing the
--   claims.completion_date-based trigger). Fixed below to restore the live
--   comment text verbatim, captured via:
--     SELECT obj_description('public.apply_referral_commission()'::regprocedure, 'pg_proc');
--
-- Filename renamed from v116-rollback-home-inspector-no-fee-commission.sql
-- to the v{N}r-{slug} convention in Docs/sql-migration-conventions.md
-- (this PR was never applied, so no schema_migrations entry exists under
-- the old name — safe to rename per that doc's own carve-out).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  IF NEW.referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = NEW.referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT id, total_price INTO v_quote_id, v_total_price
    FROM public.quotes
    WHERE claim_id = NEW.id
      AND status IN ('selected', 'awarded')
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1;

  IF v_quote_id IS NULL OR COALESCE(v_total_price, 0) < 10000 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = v_total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
                             END
   WHERE id = v_referral.id;

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
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'gh-1050/D-283 + gh-916 AC2 (rebased 2026-08-19): retargeted from quotes.payment_status=succeeded (deposit/fee-charge success at contract signing) to claims.completion_date being set (job completion — currently sole write path: mark-job-complete Edge Function). On the transition, resolves the claim''s referral directly via claims.referral_id, floor-checks the winning quote''s total_price >= $10K, attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, fires notify-payout-pending via pg_net (Vault-based key, gh-752 pattern), and fires send-partner-status-email catch-up notify via pg_net (gh-916 AC2, carried forward unchanged by this rebase). Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect the completion write.';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
SELECT pg_get_functiondef(p.oid) FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'apply_referral_commission';
