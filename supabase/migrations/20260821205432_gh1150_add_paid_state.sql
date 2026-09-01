-- Migration: gh1150_add_paid_state
-- Filed by: gh-1438 migration reconciliation batch (Code lane)
-- Date filed: 2026-09-01
-- Original issue: #1150 (child of #1021 — D-293 manual commission payment)
-- Tier: 3A, autonomous (purely additive column + constraint widen)
-- Rollback: supabase/migrations_rollbacks/20260821205432_gh1150_add_paid_state_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/20260821205432_gh1150_add_paid_state_pre-flight.md
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 reconciliation (issue #1438) — it does NOT re-apply anything;
-- merging this PR is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-21, recorded in
-- supabase_migrations.schema_migrations as version 20260821205432,
-- name "gh1150_add_paid_state".
--
-- PROVENANCE: originally drafted as
-- supabase/migrations_drafts/gh1021_add_paid_state.sql (left in place,
-- untouched, for full annotated history — that file's own header already
-- cross-references "GitHub: #1150 (child of #1021)"). The SQL body below
-- was verified byte-for-byte identical to that draft (modulo the header
-- comment block and the BEGIN/COMMIT transaction wrapper, which
-- schema_migrations.statements does not retain) via a read-only query
-- against supabase_migrations.schema_migrations.statements for this
-- version, 2026-09-01, gh-1438 reconciliation. It is the literal record
-- of what ran, not a retype of the draft.

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
