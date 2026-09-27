-- v104: gh-673 + gh-653 — additive is_test column, Tier 3A, no backfill logic beyond default.
-- CORRECTED 2026-09-26 (gh-1438 part 2): this file was previously filed at
-- version 20260810232816; the real ledger row is 20260810233131 (confirmed
-- read-only this session). Content below unchanged.
-- No propagation trigger -- per gh-689, the E2E fixture sets is_test at insert and no
-- No propagation trigger — per gh-689, the E2E fixture sets is_test at insert and no
-- trigger exists anywhere in this schema; do not build one here.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.payout_approvals
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
