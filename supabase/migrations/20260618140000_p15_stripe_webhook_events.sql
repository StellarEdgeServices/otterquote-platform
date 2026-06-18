-- Migration: 20260618140000_p15_stripe_webhook_events
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit U15-1
-- Date: 2026-06-18
-- D-numbers: D-211 P15 (U15-1 — stripe-webhook event-level idempotency);
--            supports D-228 (charge.dispute.created handler — see EF dedupe guard)
-- Rollback: 20260618140000_p15_stripe_webhook_events_rollback.sql
--
-- Summary: ADDITIVE — creates the stripe_webhook_events ledger: a one-row-per-event
--          record keyed on the Stripe event.id. The stripe-webhook Edge Function
--          INSERTs into this table BEFORE running any handler/side-effect; the
--          event_id PRIMARY KEY makes a redelivered event collide (SQLSTATE 23505),
--          which the function treats as "already processed" and acks with HTTP 200.
--
--          Why: Stripe is at-least-once and redelivers on any non-2xx. Today the
--          dispute handler logs-and-continues on a duplicate disputes insert, so the
--          side-effects (evidence auto-submit, ClickUp task, admin_dispute_queue)
--          could re-fire on a redelivery. This ledger provides event-level
--          idempotency that gates every side-effect.
--
--          Scope guarantees:
--            * Net-new table only. Touches no existing table, column, policy, or row.
--            * Service-role-only: RLS is enabled with a RESTRICTIVE deny-all policy
--              for anon/authenticated (mirrors sql/v76c-rls-explicit-deny-service-role.sql,
--              which hardened hover_tokens / imported_hover_jobs / support_tickets).
--              service_role bypasses RLS, so the Edge Function still writes/reads freely.

BEGIN;

-- 1. Idempotency ledger. event_id PK is the dedupe key; received_at is audit-only.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id    text PRIMARY KEY,
  event_type  text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Lock the table down to service_role only.
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- 3. RESTRICTIVE deny-all for anon/authenticated (explicit deny — security-advisor
--    pattern from v76c). Idempotent guard so re-runs don't error.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'stripe_webhook_events'
      AND policyname = 'stripe_webhook_events_deny_all'
  ) THEN
    CREATE POLICY stripe_webhook_events_deny_all ON public.stripe_webhook_events
      AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);
  END IF;
END $$;

COMMIT;
