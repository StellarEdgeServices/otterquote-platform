-- ============================================================
-- v99 ROLLBACK — remove scope_records (#588 Phase 1)
-- Destroys frozen Exhibit A Section 1 records: Tier 3B if any
-- production rows exist. Verify SELECT COUNT(*) FROM scope_records
-- and export rows before running.
-- ============================================================

DROP POLICY IF EXISTS "homeowner_read_own_scope_records" ON public.scope_records;
DROP POLICY IF EXISTS "admin_read_scope_records" ON public.scope_records;
DROP INDEX IF EXISTS public.scope_records_active_uniq;
DROP INDEX IF EXISTS public.scope_records_claim_idx;
DROP TABLE IF EXISTS public.scope_records;
