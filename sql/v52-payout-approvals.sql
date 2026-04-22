-- ============================================================================
-- OtterQuote Payout Approvals Migration
-- ============================================================================
-- Created: 2026-04-22
-- Version: v52
-- Depends on: v7-referral-system.sql, v36-recruit-system.sql,
--             v40-commission-trigger.sql, v42-commission-reversal-trigger.sql
--
-- NOTE ON VERSIONING: v50 was used twice (v50-coi-reminders-cron.sql and
-- v50-cron-health.sql) and v51 was used for v51-cpa-version.sql. This
-- migration uses v52 to avoid collision.
--
-- Purpose (D-180):
--   All referral and recruit commissions must enter pending_approval state
--   on qualifying job completion. No Stripe transfer fires until Dustin
--   manually approves via admin-payouts.html. This migration:
--
--   1. Creates the payout_approvals table (admin-only via RLS)
--   2. Adds indexes for approval management queries
--   3. Adds rate_limit_config entries for the three new Edge Functions
--   4. Replaces apply_referral_commission() to also insert a payout_approvals
--      row and call notify-payout-pending via pg_net on each commission accrual
--   5. Grandfathers all existing unpaid commissions as pre_approved
--
-- Decisions implemented: D-180
-- ClickUp parent: 86e112r75
-- ClickUp subtasks:
--   86e116019 — SQL migration (this file)
--   86e11603n — Updated trigger (Section 4)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: payout_approvals TABLE
-- ============================================================================
-- Central ledger for all commission approvals. One row per commission event
-- (referral or recruit). Status lifecycle:
--   pending_approval → approved | rejected | auto_approved
--   pre_approved     → (historical; set on existing commissions at migration)
--
-- referral_id:  FK to referrals.id (nullable for recruit-only commissions)
-- partner_id:   FK to referral_agents.id — the commission recipient
-- payout_type:  'commission_referral' ($200 bonus) | 'commission_recruit' ($50 bonus)
-- auto_approve_at: NOW() + 7 days (MVP proxy for 5 business days)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payout_approvals (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id          UUID        REFERENCES public.referrals(id) ON DELETE SET NULL,
  payout_type          TEXT        NOT NULL
                                   CHECK (payout_type IN (
                                     'commission_referral',
                                     'commission_recruit'
                                   )),
  partner_id           UUID        REFERENCES public.referral_agents(id) ON DELETE SET NULL,
  partner_name         TEXT,
  amount               NUMERIC(10,2) NOT NULL,
  trigger_event        TEXT,         -- human-readable: "Job completed — referral <id>"
  status               TEXT        NOT NULL DEFAULT 'pending_approval'
                                   CHECK (status IN (
                                     'pending_approval',
                                     'approved',
                                     'rejected',
                                     'auto_approved',
                                     'pre_approved'
                                   )),
  rejection_reason     TEXT,
  auto_approve_at      TIMESTAMPTZ,
  approved_at          TIMESTAMPTZ,
  rejected_at          TIMESTAMPTZ,
  approved_by          TEXT,
  reminder_sent_at     TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  DEFAULT NOW()
);

COMMENT ON TABLE public.payout_approvals IS
'D-180: Commission approval ledger. Every referral and recruit commission requires manual approval (or auto-approves after 7 days). Approvals unlock commission_paid_at on the referral row.';

-- ── RLS: admin-only ──────────────────────────────────────────────────────────
ALTER TABLE public.payout_approvals ENABLE ROW LEVEL SECURITY;

-- Admin (dustinstohler1@gmail.com) can read/write everything.
CREATE POLICY "Admin full access payout_approvals"
  ON public.payout_approvals
  FOR ALL
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');

-- Partners can read their own pending/approved approvals (for dashboard display).
-- Rejection reason is intentionally excluded via the status-only badge approach
-- on partner-dashboard.html — but the row itself is readable so the frontend
-- can detect status = 'pending_approval' or 'rejected' without exposure of reason.
CREATE POLICY "Partners read own payout_approvals"
  ON public.payout_approvals
  FOR SELECT
  USING (
    partner_id IN (
      SELECT id FROM public.referral_agents
      WHERE user_id = auth.uid()
    )
  );

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Primary query patterns: fetch by status (admin list), by partner (dashboard),
-- and auto-approve scan (auto_approve_at < NOW() WHERE status = 'pending_approval').

CREATE INDEX IF NOT EXISTS idx_payout_approvals_status
  ON public.payout_approvals(status);

CREATE INDEX IF NOT EXISTS idx_payout_approvals_partner_id
  ON public.payout_approvals(partner_id);

CREATE INDEX IF NOT EXISTS idx_payout_approvals_referral_id
  ON public.payout_approvals(referral_id);

CREATE INDEX IF NOT EXISTS idx_payout_approvals_auto_approve_at
  ON public.payout_approvals(auto_approve_at)
  WHERE status = 'pending_approval';

CREATE INDEX IF NOT EXISTS idx_payout_approvals_created_at
  ON public.payout_approvals(created_at);

-- ── Reminder index (process-payout-reminders day-2 scan) ────────────────────
CREATE INDEX IF NOT EXISTS idx_payout_approvals_reminder
  ON public.payout_approvals(created_at, reminder_sent_at)
  WHERE status = 'pending_approval';

-- ============================================================================
-- SECTION 2: GRANDFATHER EXISTING UNPAID COMMISSIONS AS pre_approved
-- ============================================================================
-- All commissions that existed before D-180 are grandfathered as pre_approved
-- so they don't require approval before the payout can fire. We create one
-- payout_approvals row per referral that has commission_amount > 0 and
-- commission_paid_at IS NULL (still unpaid = needs grandfathering).
--
-- Referrals with commission_paid_at already set were already paid out — no
-- grandfathering row needed (nothing to approve; money already moved).
-- ============================================================================

INSERT INTO public.payout_approvals (
  referral_id,
  payout_type,
  partner_id,
  partner_name,
  amount,
  trigger_event,
  status,
  auto_approve_at,
  approved_at,
  approved_by,
  notification_sent_at,
  created_at
)
SELECT
  r.id                        AS referral_id,
  'commission_referral'       AS payout_type,
  r.referral_agent_id         AS partner_id,
  TRIM(COALESCE(ra.first_name, '') || ' ' || COALESCE(ra.last_name, '')) AS partner_name,
  r.commission_amount         AS amount,
  'Pre-existing commission — grandfathered per D-180' AS trigger_event,
  'pre_approved'              AS status,
  NULL                        AS auto_approve_at,
  NOW()                       AS approved_at,
  'system (D-180 migration)'  AS approved_by,
  NOW()                       AS notification_sent_at,
  r.created_at                AS created_at
FROM public.referrals r
JOIN public.referral_agents ra ON ra.id = r.referral_agent_id
WHERE r.commission_amount > 0
  AND r.commission_paid_at IS NULL;

-- Grandfather recruit commissions similarly
INSERT INTO public.payout_approvals (
  referral_id,
  payout_type,
  partner_id,
  partner_name,
  amount,
  trigger_event,
  status,
  auto_approve_at,
  approved_at,
  approved_by,
  notification_sent_at,
  created_at
)
SELECT
  r.id                        AS referral_id,
  'commission_recruit'        AS payout_type,
  recruiter.id                AS partner_id,
  TRIM(COALESCE(recruiter.first_name, '') || ' ' || COALESCE(recruiter.last_name, '')) AS partner_name,
  r.recruit_commission_amount AS amount,
  'Pre-existing recruit commission — grandfathered per D-180' AS trigger_event,
  'pre_approved'              AS status,
  NULL                        AS auto_approve_at,
  NOW()                       AS approved_at,
  'system (D-180 migration)'  AS approved_by,
  NOW()                       AS notification_sent_at,
  r.created_at                AS created_at
FROM public.referrals r
JOIN public.referral_agents referrer  ON referrer.id = r.referral_agent_id
JOIN public.referral_agents recruiter ON recruiter.id = referrer.recruited_by_id
WHERE r.recruit_commission_amount > 0
  AND r.commission_paid_at IS NULL  -- Using commission_paid_at as the unified
                                     -- payout gate per v40 design. recruit_paid_at
                                     -- follows separately when available.
  AND referrer.recruited_by_id IS NOT NULL;

-- ============================================================================
-- SECTION 3: rate_limit_config ENTRIES FOR NEW EDGE FUNCTIONS
-- ============================================================================
-- Caps are conservative for MVP. Adjust via Admin → ClickUp task if daily
-- approval volume exceeds these during production.
-- ============================================================================

INSERT INTO public.rate_limit_config
  (function_name, max_per_day, max_per_month, enabled, notes)
VALUES
  -- approve-payout: admin-only, low volume
  ('approve-payout',           200,  2000,  true, 'D-180: Admin commission approval endpoint'),
  -- reject-payout: admin-only, low volume
  ('reject-payout',            200,  2000,  true, 'D-180: Admin commission rejection endpoint'),
  -- notify-payout-pending: fires once per commission; capped generously
  ('notify-payout-pending',    500,  5000,  true, 'D-180: Immediate payout pending notification to Dustin'),
  -- process-payout-reminders: cron, runs once daily
  ('process-payout-reminders', 10,   300,   true, 'D-180: Daily payout reminder + auto-approve cron')
ON CONFLICT (function_name) DO NOTHING;

-- ============================================================================
-- SECTION 4: UPDATED apply_referral_commission() — adds payout_approvals insert
-- ============================================================================
-- Extends v40's trigger function to:
--   a) Insert a payout_approvals row (status='pending_approval') for each
--      commission accrued.
--   b) Call notify-payout-pending via pg_net.http_post() to trigger an
--      immediate email to Dustin. Uses pg_net's async fire-and-forget pattern;
--      the HTTP call failure is swallowed inside the EXCEPTION handler so the
--      payment transaction is never rolled back.
--
-- The trigger attached to quotes (after_quote_paid) is NOT re-created here
-- because DROP TRIGGER / CREATE TRIGGER was done in v40 and the function
-- name/signature is unchanged. PostgreSQL resolves the trigger function
-- by name at call time, so replacing the function body is sufficient.
--
-- auto_approve_at = NOW() + INTERVAL '7 days' (MVP proxy for 5 business days).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claim_referral_id   UUID;
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_supabase_url        TEXT;
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

  -- 5. Apply the $200 referrer bonus and advance status to 'job_completed'.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status = 'commission_paid'
                                 THEN status
                               ELSE 'job_completed'
                             END
   WHERE id = v_referral.id;

  -- 6. Insert payout_approval for the referral commission.
  INSERT INTO public.payout_approvals (
    referral_id,
    payout_type,
    partner_id,
    partner_name,
    amount,
    trigger_event,
    status,
    auto_approve_at
  )
  VALUES (
    v_referral.id,
    'commission_referral',
    v_referrer.id,
    TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')),
    200,
    'Job completed — referral ' || v_referral.id::TEXT || ' (quote ' || NEW.id::TEXT || ')',
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

    -- Load recruiter name for the approval row.
    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    -- Insert payout_approval for the recruit commission.
    INSERT INTO public.payout_approvals (
      referral_id,
      payout_type,
      partner_id,
      partner_name,
      amount,
      trigger_event,
      status,
      auto_approve_at
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
  --    If pg_net is not available or the call fails, the EXCEPTION handler
  --    below swallows it — payment integrity is never at risk.
  --    The notify-payout-pending function also tolerates duplicate calls
  --    (idempotent via notification_sent_at).
  BEGIN
    v_supabase_url      := current_setting('app.supabase_url',      true);
    v_service_role_key  := current_setting('app.service_role_key',  true);

    IF v_supabase_url IS NOT NULL AND v_service_role_key IS NOT NULL
       AND v_referral_approval IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_supabase_url || '/functions/v1/notify-payout-pending',
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
  -- Never allow a commission-side failure to roll back the payment itself.
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
'D-180 (v52): Extended from v40. On payment_status transition to succeeded (>=$10K job), attributes $200 referrer + optional $50 recruiter commission, inserts payout_approvals rows with status=pending_approval, and fires notify-payout-pending via pg_net. Idempotent via commission_amount > 0 guard. SECURITY DEFINER; all errors swallowed to protect payment integrity.';

-- ============================================================================
-- SECTION 5: VERIFICATION QUERIES
-- ============================================================================
-- Run after applying to confirm schema is correct.

-- 5a. Confirm payout_approvals table exists with expected columns.
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'payout_approvals'
ORDER BY ordinal_position;

-- 5b. Confirm RLS is enabled.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename  = 'payout_approvals';

-- 5c. Confirm indexes exist.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'payout_approvals';

-- 5d. Confirm rate_limit_config entries.
SELECT function_name, daily_limit, monthly_limit, enabled
FROM public.rate_limit_config
WHERE function_name IN (
  'approve-payout',
  'reject-payout',
  'notify-payout-pending',
  'process-payout-reminders'
);

-- 5e. Confirm apply_referral_commission() is updated