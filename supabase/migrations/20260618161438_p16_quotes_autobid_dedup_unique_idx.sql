-- Migration: 20260618161438_p16_quotes_autobid_dedup_unique_idx
-- Author: Claude Code (Opus 4.8) — D-211 Phase 16, Unit 0
-- Date: 2026-06-18
-- D-numbers: D-211 P16 (UNIT 0 — process-auto-bids 500 fix); D-150 (14-day auto-bid window)
-- Rollback: 20260618161438_p16_quotes_autobid_dedup_unique_idx_rollback.sql
--
-- Summary: ADDITIVE — adds a partial UNIQUE index that enforces one auto-bid per
--          (claim_id, contractor_id, trade_type) tuple. process-auto-bids runs on a
--          ~5-min pg_cron and its in-memory dedupe (existing-quotes set) can race two
--          overlapping runs into a double auto-bid for the same claim+contractor+trade.
--          This index is the durable backstop: the second insert collides (SQLSTATE
--          23505), which the Edge Function now treats as "already bid" and skips
--          (benign) rather than erroring.
--
--          Partial (WHERE is_auto_bid = true): scopes the constraint to auto-bids only,
--          so manually-submitted quotes are unaffected.
--
--          Scope guarantees:
--            * Net-new index only. Touches no existing column, policy, or row.
--            * Idempotent (IF NOT EXISTS) — already applied to PROD via apply_migration;
--              this file is committed for repo/drift parity.
--
-- Repo-reconciliation (D-211 Phase 18 Unit 4): renamed from the placeholder version
-- 20260618150000_p16_quotes_autobid_unique_idx to the real applied identity recorded in
-- supabase_migrations.schema_migrations (version 20260618161438, name
-- p16_quotes_autobid_dedup_unique_idx) so `supabase migration list` / `db push` recognizes
-- it as applied and never re-runs it. Index DDL unchanged.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_autobid_unique_idx
  ON public.quotes (claim_id, contractor_id, trade_type) WHERE is_auto_bid = true;

COMMIT;
