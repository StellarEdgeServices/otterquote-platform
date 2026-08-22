-- Migration: gh1021_add_paid_state
-- Author: Code lane sub-agent (automated), run-work orchestration
-- Date: 2026-08-21
-- Status: DRAFT — Tier 3A, autonomous (no D-182 approval / R-097 notice owed;
--         see pre-flight for the #916 tier-test citation).
-- Rollback: gh1021_add_paid_state_rollback.sql
-- Pre-flight: gh1021_add_paid_state_pre-flight.md
-- GitHub: #1150 (child of #1021 — D-293 manual commission payment)
--
-- Summary: adds a nullable paid_at timestamptz column to public.payout_approvals
-- and widens payout_approvals_status_check to additionally admit 'paid', while
-- preserving every value already admitted today: pending_approval, approved,
-- rejected, auto_approved, pre_approved. Purely additive — nothing reads or
-- writes the new column yet. That wiring (Edge Function + dashboard) is a
-- separate Tier-3B child of #1021, not this migration.
--
-- Live pre-verification (this session, 2026-08-21) confirmed the existing
-- constraint is exactly:
--   CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text,
--     'rejected'::text, 'auto_approved'::text, 'pre_approved'::text])))
-- The DROP+ADD below reproduces every one of those five values verbatim and
-- adds exactly one more ('paid').

BEGIN;

ALTER TABLE public.payout_approvals
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL;

ALTER TABLE public.payout_approvals
  DROP CONSTRAINT IF EXISTS payout_approvals_status_check;

ALTER TABLE public.payout_approvals
  ADD CONSTRAINT payout_approvals_status_check
  CHECK (status = ANY (ARRAY[
    'pending_approval'::text,
    'approved'::text,
    'rejected'::text,
    'auto_approved'::text,
    'pre_approved'::text,
    'paid'::text
  ]));

COMMIT;
