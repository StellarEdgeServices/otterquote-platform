-- gh-916 AC2: progressive partner-status-email trigger wiring
-- Tier 3B (D-182). Approved by Dustin, verbatim: "APPROVED. APPLY IT."
-- (issue #916 comment 5346443245, cross-filed on #856 comment 5346443788).
-- R-097 disposition: no 24h notice owed — Bridge ruling (comment 5346544316)
-- that a notice window is not owed on a change the principal already ruled
-- on by name. Applied to production yeszghaspzwwstvsrioa via apply_migration
-- 2026-08-19 (D-221 Path A: this repo file is added post-apply to keep a
-- trace, matching the gh-752/gh-886 precedent — merging this PR does NOT
-- (re-)apply the migration, it already ran).
--
-- Drafted 2026-08-18 (session rw-f22-20260818T220818-7e2a, PR #1046) as
-- supabase/migrations_drafts/gh916_progressive_partner_status_triggers.sql;
-- applied 2026-08-19 (session rw-916-f22-b1ap) after a Gate 5.5 premise
-- re-check confirmed the live bodies of claims_advance_referral() and
-- apply_referral_commission() still matched the draft's assumed prior
-- state byte-for-byte (logic-identical; only a comment-text difference in
-- apply_referral_commission's section 8, which CREATE OR REPLACE overwrites
-- regardless) and the Vault secret cron_service_role_key was confirmed
-- populated live.
--
-- Summary: wires the two DB-trigger sites #916 AC2 names — claims_advance_referral()
-- and apply_referral_commission() — plus a brand-new trigger on quotes AFTER INSERT
-- (the "bid_received / submitted for bids" signal #916 found had NO live write path
-- anywhere in the schema) to fire send-partner-status-email progressively as a
-- referral's linked claim actually advances, instead of only retroactively at job
-- completion (the prior #923 wiring via mark-job-complete).
--
-- Design choice — catch-up mode, not a hardcoded `stage` number, at every site:
-- send-partner-status-email already does its own eligibility detection straight
-- from live claims/quotes state (not referrals.status) and its own compare-and-swap
-- idempotency guard (referrals.metadata.partner_status_series). Passing only
-- {referral_id} and letting the function decide what is currently eligible-and-unsent
-- means these three trigger sites cannot send a duplicate or a wrong-stage email even
-- if their timing doesn't line up perfectly with the function's own internal stage
-- semantics.
--
-- Vault key pattern: identical to gh-752 (Dustin-approved, applied 2026-08-17) —
-- `vault.decrypted_secrets` / 'cron_service_role_key', NOT the app.* GUCs (confirmed
-- NULL/unset on this database by #752's live audit). Every new pg_net call is
-- wrapped in its own BEGIN/EXCEPTION block so a failure can NEVER roll back or
-- block the underlying claims/quotes/commission write those triggers exist to
-- protect.
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
--
-- Post-apply live verification (rw-916-f22-b1ap, 2026-08-19):
--   - pg_get_functiondef on all 3 touched functions shows the new bodies live.
--   - trg_notify_partner_status_on_bid_submitted exists on public.quotes, enabled.
--   - Full end-to-end smoke, zero real-partner impact: inserted an is_test=true
--     quotes row against the designated E2E TEST CLAIM (claim_id
--     8dcf76f1-f518-4363-a37f-192dec10b9bb, referral_id
--     ea75db9f-0f49-4aec-aaa4-45cc82ef7aa3, agent email
--     dustinstohler1+jjdemo0805@gmail.com — Dustin's own test inbox, no real
--     partner touched). The new trigger fired, called send-partner-status-email,
--     which returned 200 {"ok":true,"sent":[{"stage":2,"mailgun_id":
--     "<20260819211047.4fd9a9e007d91b2f@mail.otterquote.com>"}],"skipped":[stage 1
--     already sent, stages 3-5 not eligible yet]} (net._http_response id 5085),
--     and referrals.metadata.partner_status_series picked up stage2_sent_at.
--     rate_limits shows blocked:false. This is the first live exercise of the
--     progressive (non-retroactive) delivery path added by this migration.
--
-- Rollback: supabase/migrations_rollbacks/gh916_progressive_partner_status_triggers_rollback.sql

BEGIN;

-- ============================================================================
-- SITE 1: claims_advance_referral() — stage 1 (claim_submitted) + catch-up
-- ============================================================================
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
  -- gh-752: service-role key now resolved from Vault; the app.* GUCs this
  -- block used to read are not set on this database, which silently skipped
  -- the call. A missing Vault secret is now RAISE LOGged instead of skipped
  -- silently. EXCEPTION handler below still swallows any pg_net failure —
  -- payment integrity is never at risk.
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
