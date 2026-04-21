-- ============================================================================
-- OtterQuote W-9 Requirement Migration
-- ============================================================================
-- Created: 2026-04-21
-- Version: v49
-- Depends on: v7-referral-system.sql, v36-recruit-system.sql, v40-commission-trigger.sql
--
-- Purpose: Implements D-172 — W-9 gate for referral partner commissions.
--   New partners default to payments_blocked=true. When after_quote_paid fires
--   for a blocked partner, the commission is withheld, a one-time W-9 request
--   email is sent via notify-partner-w9 Edge Function (pg_net), and
--   w9_notification_sent_at is stamped as an idempotency guard so the email
--   never fires twice for the same partner.
--
-- Schema changes:
--   referral_agents: w9_file_url, w9_submitted_at, w9_verified_at,
--                    payments_blocked, w9_notification_sent_at
--
-- Trigger change:
--   apply_referral_commission() extended with payments_blocked gate
--   before Steps 5 & 6 (pay commission).
--
-- Prerequisites already met in this DB:
--   - app.service_role_key is set (v44 pg_cron jobs use it)
--   - app.supabase_url is set (v44 pg_cron jobs use it)
--   - net.http_post (pg_net) is enabled (used by all cron jobs since v44)
--
-- SECURITY NOTE: app.service_role_key contains the Supabase service role key.
--   This setting is server-side only (not accessible to anon/authenticated
--   PostgreSQL roles). The trigger is SECURITY DEFINER. Rotate the service
--   role key before launch per the pre-launch security checklist.
--
-- Decisions implemented: D-172
-- ClickUp: 86e0zrnac, 86e0zrnb6, 86e0zrnbh, 86e0zrngp, 86e0zrnnf,
--          86e0zrnwn, 86e0zrp8j, 86e0zrpd6, 86e0zrpjq
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: NEW COLUMNS — referral_agents
-- ============================================================================

-- w9_file_url: Storage path in partner-photos bucket (w9/{user_id}/{ts}.pdf).
-- Populated by submit-partner-w9 Edge Function on partner upload.
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS w9_file_url TEXT;

COMMENT ON COLUMN public.referral_agents.w9_file_url IS
'Storage path to the W-9 PDF uploaded by this partner in the partner-photos bucket (prefix: w9/{user_id}/). Set by the submit-partner-w9 Edge Function. NULL until the partner submits a W-9.';

-- w9_submitted_at: Timestamp when the partner submitted their W-9.
-- Set by submit-partner-w9 Edge Function alongside w9_file_url.
-- Cleared to NULL if the partner re-submits (replaces the prior upload).
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS w9_submitted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.referral_agents.w9_submitted_at IS
'Timestamp when this partner last submitted a W-9 via submit-partner-w9. NULL until first submission.';

-- w9_verified_at: Timestamp when Dustin manually verified the W-9.
-- Set via the admin-referrals.html "Verify W-9" button.
-- Does not directly affect payments_blocked — admin workflow step only.
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS w9_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.referral_agents.w9_verified_at IS
'Timestamp when Dustin (admin) manually verified the submitted W-9. Set via the admin-referrals.html Verify W-9 action. NULL until verified.';

-- payments_blocked: Payment gate. TRUE blocks commission payouts in
-- apply_referral_commission(). New partners default to TRUE (blocked) until
-- they submit a W-9. Cleared to FALSE by submit-partner-w9 Edge Function.
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS payments_blocked BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.referral_agents.payments_blocked IS
'Payment gate flag. TRUE = commission payouts blocked pending W-9 submission. Defaults to TRUE for new partners. Set to FALSE by submit-partner-w9 when partner uploads a valid W-9. The apply_referral_commission() trigger checks this before paying any commission.';

-- w9_notification_sent_at: Idempotency guard for the W-9 request email.
-- Set by apply_referral_commission() the FIRST time a payment is blocked for
-- a given partner. Checked on every subsequent trigger fire — if non-NULL,
-- the email is suppressed (no duplicate sends).
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS w9_notification_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.referral_agents.w9_notification_sent_at IS
'Timestamp when the W-9 request email was sent to this partner. Set by apply_referral_commission() on the first payment-block event. NULL = email not yet sent; non-NULL = email already sent (suppresses re-sends on subsequent trigger fires).';

-- ============================================================================
-- SECTION 2: BACKFILL — grandfather existing partners
-- ============================================================================
-- Existing referral_agents rows were added before D-172. They predate the W-9
-- requirement and should not be blocked. Set payments_blocked = false for all
-- rows that currently have the default (true) and have no w9_notification_sent.
-- This is a one-time backfill; new rows created after this migration will
-- correctly default to payments_blocked = true.
-- ============================================================================
UPDATE public.referral_agents
   SET payments_blocked = false
 WHERE payments_blocked = true;

-- ============================================================================
-- SECTION 3: INDEX — payments_blocked
-- ============================================================================
-- Partial index: only indexes blocked rows, which will be a small minority of
-- all partners. Supports the admin "Blocked" filter on admin-referrals.html
-- and the trigger lookup path.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_referral_agents_payments_blocked
  ON public.referral_agents(payments_blocked)
  WHERE payments_blocked = true;

-- ============================================================================
-- SECTION 4: RATE LIMIT ENTRY — submit-partner-w9
-- ============================================================================
-- Added here alongside schema so the Edge Function deploys with spend controls
-- already in place. 10/day, 30/month — W-9 uploads are low-volume.
-- ============================================================================
INSERT INTO public.rate_limit_config (function_name, max_per_day, max_per_month, enabled)
VALUES ('submit-partner-w9', 10, 30, true)
ON CONFLICT (function_name) DO NOTHING;

-- ============================================================================
-- SECTION 5: EXTEND apply_referral_commission() — W-9 gate
-- ============================================================================
-- Replaces the v40 function. All original logic preserved; W-9 gate is
-- inserted between Step 4 (load referrer) and Step 5 (pay commission).
--
-- Gate logic:
--   IF payments_blocked AND w9_notification_sent_at IS NULL:
--     stamp w9_notification_sent_at = NOW()
--     call notify-partner-w9 via pg_net (fire-and-forget, non-fatal)
--     RETURN NEW (skip payment)
--   IF payments_blocked AND w9_notification_sent_at IS NOT NULL:
--     RETURN NEW (skip payment — no duplicate email)
--   ELSE: proceed with commission payment as before
--
-- The pg_net call is non-blocking. Any failure is caught and logged;
-- it does NOT roll back the payment (consistent with the existing exception
-- handler at the bottom of this function — payment integrity is primary).
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
  v_supabase_url      TEXT;
  v_service_key       TEXT;
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
  --    writes.
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

  -- 4. Load the referrer. A referral row with no referral_agent is
  --    malformed — skip silently.
  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- ── D-172 W-9 GATE ───────────────────────────────────────────────────────
  -- Check payments_blocked before paying any commission.
  IF v_referrer.payments_blocked = true THEN

    IF v_referrer.w9_notification_sent_at IS NULL THEN
      -- First block for this partner: stamp the notification timestamp and
      -- fire the W-9 request email via notify-partner-w9 Edge Function.
      UPDATE public.referral_agents
         SET w9_notification_sent_at = NOW()
       WHERE id = v_referrer.id;

      -- Retrieve app-level settings (set by v44 cron setup, already live).
      v_supabase_url := current_setting('app.supabase_url',  true);
      v_service_key  := current_setting('app.service_role_key', true);

      IF v_supabase_url IS NOT NULL AND v_service_key IS NOT NULL THEN
        BEGIN
          PERFORM net.http_post(
            url     := v_supabase_url || '/functions/v1/notify-partner-w9',
            body    := jsonb_build_object('agent_id', v_referrer.id)::text::bytea,
            headers := jsonb_build_object(
              'Content-Type',  'application/json',
              'Authorization', 'Bearer ' || v_service_key
            )
          );
        EXCEPTION
          WHEN OTHERS THEN
            RAISE LOG 'apply_referral_commission: notify-partner-w9 pg_net call failed for agent_id=% sqlstate=% sqlerrm=%',
              v_referrer.id, SQLSTATE, SQLERRM;
        END;
      ELSE
        RAISE LOG 'apply_referral_commission: app.supabase_url or app.service_role_key not set — W-9 notification not sent for agent_id=%',
          v_referrer.id;
      END IF;
    END IF;
    -- Whether first block or repeat block: skip payment entirely.
    RETURN NEW;
  END IF;
  -- ── END W-9 GATE ─────────────────────────────────────────────────────────

  -- 5. Apply the $200 referrer bonus.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
                             END
   WHERE id = v_referral.id;

  -- 6. Forward-only recruit bonus per D-142.
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
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'Trigger function attached to quotes AFTER UPDATE OF payment_status. On transition to ''succeeded'' with total_price >= $10,000: (1) checks payments_blocked on referral_agent — if true, withholds commission, sends one-time W-9 request email via notify-partner-w9 Edge Function (pg_net), returns; (2) if not blocked, attributes $200 to referrer and $50 to recruiter per D-139/D-140/D-141/D-142. Idempotent. SECURITY DEFINER. All errors swallowed and logged to protect payment integrity. D-172 W-9 gate added v49.';

COMMIT;

-- ============================================================================
-- SECTION 6: VERIFICATION QUERIES
-- ============================================================================

-- 6a. Confirm all 5 new columns exist on referral_agents.
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'referral_agents'
  AND column_name  IN (
    'w9_file_url', 'w9_submitted_at', 'w9_verified_at',
    'payments_blocked', 'w9_notification_sent_at'
  )
ORDER BY column_name;

-- 6b. Confirm backfill: no existing partners should be blocked.
SELECT COUNT(*) AS still_blocked
FROM public.referral_agents
WHERE payments_blocked = true;
-- Expected: 0 (all existing partners grandfathered)

-- 6c. Confirm index exists.
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'referral_agents'
  AND indexname = 'idx_referral_agents_payments_blocked';

-- 6d. Confirm rate limit entry.
SELECT function_name, max_per_day, max_per_month, enabled
FROM public.rate_limit_config
WHERE function_name = 'submit-partner-w9';

-- 6e. Confirm trigger function was updated (check comment).
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'apply_referral_commission'
  AND pronamespace = 'public'::regnamespace;

-- ============================================================================
-- End of Migration v49 — W-9 Requirement (D-172)
-- ============================================================================
