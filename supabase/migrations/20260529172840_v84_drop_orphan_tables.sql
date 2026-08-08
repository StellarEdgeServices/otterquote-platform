-- v84_drop_orphan_tables.sql
-- Migration: Drop four orphaned tables that predate D-182 and current claim flow
-- ClickUp: 86e1j588x
-- CTO Decision Date: 2026-05-26
-- D-numbers: D-220 (Tier 3 approval), D-221 (deploy chain)
--
-- Tables removed (all confirmed 0 rows + 0 inbound FKs at 2026-05-27):
--   documents             — predates D-182 DocuSign flow
--   job_assignments       — superseded by `bids` table
--   inspection_bookings   — orphaned inspection concept
--   claim_trade_items     — orphaned line-item concept
--
-- Pre-flight verification (run via Supabase MCP 2026-05-27):
--   All four tables: live_rows=0, inbound_fk_count=0
--
-- Known orphan code path (does NOT block this migration):
--   schedule-inspection.html line 997 references `inspection_bookings`.
--   The page is reachable from repair-intake.html. Page should be removed
--   in a follow-up cleanup task — see Pre-flight § Orphan Code Followups.
--
-- Forward-only side effects: CASCADE drops associated RLS policies, indexes,
-- and the set_updated_at_job_assignments trigger.

BEGIN;

-- Safety net: refuse to run if any table has gained rows since pre-flight
DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT COALESCE(SUM(n_live_tup), 0) INTO v_count
  FROM pg_stat_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('documents','job_assignments','inspection_bookings','claim_trade_items');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'Aborting v84: orphan tables now contain % rows. Re-verify before dropping.', v_count;
  END IF;
END $$;

DROP TABLE IF EXISTS public.claim_trade_items CASCADE;
DROP TABLE IF EXISTS public.inspection_bookings CASCADE;
DROP TABLE IF EXISTS public.job_assignments CASCADE;
DROP TABLE IF EXISTS public.documents CASCADE;

COMMIT;
