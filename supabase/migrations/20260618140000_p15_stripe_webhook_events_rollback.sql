-- Rollback: 20260618140000_p15_stripe_webhook_events_rollback.sql
-- Reverts: 20260618140000_p15_stripe_webhook_events.sql
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit U15-1
-- Date: 2026-06-18
--
-- Drops the stripe_webhook_events idempotency ledger. DROP TABLE also drops the
-- table's RLS policy, so no separate policy drop is needed. Idempotent (IF EXISTS).
--
-- NOTE: After this rollback the stripe-webhook Edge Function's dedupe guard will
--       fail its ledger INSERT (table gone). Roll back the EF deploy together with
--       this migration — the guard returns HTTP 500 on a non-23505 insert error,
--       which would cause Stripe to retry rather than process without a ledger.

BEGIN;

DROP TABLE IF EXISTS public.stripe_webhook_events;

COMMIT;
