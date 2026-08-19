-- Migration: gh916_progressive_partner_status_triggers
-- Author: Code lane sub-agent (automated), run-work orchestration
-- Date: 2026-08-18
-- Status: DRAFT ONLY — DO NOT APPLY. Tier 3 (D-182) approval pending.
-- Rollback: gh916_progressive_partner_status_triggers_rollback.sql
-- Pre-flight: gh916_progressive_partner_status_triggers_pre-flight.md
-- GitHub: #916 AC2 (also closes the last open gap on #856)
--
-- Summary: wires the two DB-trigger sites #916 AC2 names — claims_advance_referral()
-- and apply_referral_commission() — plus a brand-new trigger on quotes AFTER INSERT
-- (the "bid_received / submitted for bids" signal #916 found had NO live write path
-- anywhere in the schema) to fire send-partner-status-email progressively as a
-- referral's linked claim actually advances, instead of only retroactively at job
-- completion (the current #923 wiring via mark-job-complete).
--
-- Design choice — catch-up mode, not a hardcoded `stage` number, at every site:
-- send-partner-status-email already does its own eligibility detection straight
-- from live claims/quotes state (not referrals.status) and its own compare-and-swap
-- idempotency guard (referrals.metadata.partner_status_series). Passing only
-- {referral_id} and letting the function decide what is currently eligible-and-unsent
-- means these three trigger sites cannot send a duplicate or a wrong-stage email even
-- if their timing doesn't line up perfectly with the function's own internal stage
-- semantics — it is the same "poll and catch up" pattern already proven live by the
-- mark-job-complete wiring (#923).
--
-- Vault key pattern: identical to gh-752 (Dustin-approved, applied 2026-08-17) —
-- `vault.decrypted_secrets` / 'cron_service_role_key', NOT the app.* GUCs (confirmed
-- NULL/unset on this database by #752's live audit). Every new pg_net call is wrapped
-- in its own BEGIN/EXCEPTION block so a failure can NEVER roll back or block the
-- underlying claims/quotes/commission write those triggers exist to protect.
--
-- Sites touched:
--   1. claims_advance_referral()  — fires at intake. Notify only added when the
--      referral's status was actually advanced (v_rows_updated > 0), not on every
--      unrelated claims write.
--   2. notify_partner_status_on_bid_submitted() [NEW] + trigger on quotes AFTER
--      INSERT — the missing "bid submitted" signal.
--   3. apply_referral_commission() — reuses the Vault key it already resolves for
--      its existing notify-payout-pending call; independent BEGIN/EXCEPTION block so
--      the two notify paths can never affect each other.
--
-- NOT touched (confirmed settled non-goals, see #916 comment history / PR #965):
--   approve-payout — send-partner-status-email's own header documents stage 5
--   (job_completed) as owned by mark-job-complete, not commission_paid. PR #965
--   built this wiring and was closed unmerged by the Bridge as a deliberate non-goal.

BEGIN;

-- ============================================================================
-- SITE 1: claims_advance_referral() — stage 1 (claim_submitted) + catch-up
-- ============================================================================
-- Prior body (unchanged logic) is preserved byte-for-byte; only the DECLARE
-- list and the new IF block after RETURN-guarding are additions.
CREATE OR REPLACE FUNCTION public.claims_advance_referral()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_updated      INT;
  v_service_role_key  TEXT;
BEGIN
  BEGIN
    UPDATE referrals
       SET status = 'claim_submitted'
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered');
    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_rows_updated := 0;
    NULL;  -- never break the claim write
  END;

  -- gh-916 AC2: progressive partner-status notify, catch-up mode. Only fires
  -- when this trigger actually advanced the referral, to avoid firing on
  -- every unrelated claims write with the same referral_id. Independent
  -- BEGIN/EXCEPTION block — a failure here must never break the claims write
  -- this trigger exists to protect.
  IF v_rows_updated > 0 THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_role_key
        FROM vault.decrypted_secrets
       WHERE name = 'cron_service_role_key';

      IF v_service_role_key IS NULL THEN
        RAISE LOG 'claims_advance_referral: vault secret cron_service_role_key not found — skipping send-partner-status-email for referral_id=%', NEW.referral_id;
      ELSE
        PERFORM net.http_post(
          url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
          ),
          body    := jsonb_build_object('referral_id', NEW.referral_id)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'claims_advance_referral: pg_net call to send-partner-status-email failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
        NEW.referral_id, SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$
;

-- ============================================================================
-- SITE 2: notify_partner_status_on_bid_submitted() [NEW] — stage 2 (bid_received)
-- ============================================================================
-- This is the write path #916 found missing entirely: nothing in the live
-- schema fires anything at the moment a claim's first bid is submitted.
-- Isolated, single-purpose trigger — does not touch log_bid_submitted() or
-- any other existing quotes-insert trigger.
CREATE OR REPLACE FUNCTION public.notify_partner_status_on_bid_submitted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral_id       UUID;
  v_service_role_key  TEXT;
BEGIN
  SELECT c.referral_id INTO v_referral_id
    FROM public.claims c
   WHERE c.id = NEW.claim_id;

  IF v_referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_role_key
      FROM vault.decrypted_secrets
     WHERE name = 'cron_service_role_key';

    IF v_service_role_key IS NULL THEN
      RAISE LOG 'notify_partner_status_on_bid_submitted: vault secret cron_service_role_key not found — skipping for referral_id=%', v_referral_id;
    ELSE
      PERFORM net.http_post(
        url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_role_key
        ),
        body    := jsonb_build_object('referral_id', v_referral_id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'notify_partner_status_on_bid_submitted: pg_net call failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
      v_referral_id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Outer guard: never let this new trigger break a bid submission.
  RAISE LOG 'notify_partner_status_on_bid_submitted failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
    NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

DROP TRIGGER IF EXISTS trg_notify_partner_status_on_bid_submitted ON public.quotes;

CREATE TRIGGER trg_notify_partner_status_on_bid_submitted
  AFTER INSERT ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_partner_status_on_bid_submitted();

COMMENT ON TRIGGER trg_notify_partner_status_on_bid_submitted ON public.quotes IS
'gh-916 AC2: fires send-partner-status-email (catch-up mode) when a bid is submitted for a claim linked to a referral — the "bid_received / submitted for bids" signal that previously had no live write path anywhere in the schema. Non-fatal; never blocks the bid insert.';

-- ============================================================================
-- SITE 3: apply_referral_commission() — stage 3/4 catch-up
-- ============================================================================
-- Sections 1-7 are byte-identical to the live definition applied by gh-752
-- (2026-08-17). Only the added BEGIN/EXCEPTION block after the existing
-- notify-payout-pending call (section 8) is new.
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
    referral_id, payout_type, partner_id, partner_name,
    amount, trigger_event, status, auto_approve_at
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

  -- 8. Fire notify-payout-pending via pg_net (async, fire-and-forget).
  -- gh-752: service-role key resolved from Vault.
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

  -- 9. gh-916 AC2: progressive partner-status notify, catch-up mode.
  -- Independent BEGIN/EXCEPTION block from step 8 — a failure sending the
  -- partner-status email can never affect the notify-payout-pending call
  -- above, and vice versa. Reuses v_service_role_key if step 8 already
  -- resolved it; re-resolves only if step 8's Vault lookup itself failed.
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
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMIT;
