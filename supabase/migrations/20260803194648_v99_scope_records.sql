-- Migration: v99_scope_records
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-03T19:46:48Z, recorded in
-- supabase_migrations.schema_migrations as version 20260803194648, name
-- "v99_scope_records". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v99 — scope_records: frozen Exhibit A Section 1 storage (#588 Phase 1)
-- Tier 3A additive. Rollback: sql/v99-rollback-scope-records.sql

CREATE TABLE IF NOT EXISTS public.scope_records (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         UUID        NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  trade            TEXT        NOT NULL DEFAULT 'roofing',
  catalog_version  TEXT        NOT NULL,
  scope_json       JSONB       NOT NULL,
  content_hash     TEXT        NOT NULL,
  version          INTEGER     NOT NULL DEFAULT 1,
  source           TEXT,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS scope_records_active_uniq
  ON public.scope_records (claim_id, trade)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS scope_records_claim_idx
  ON public.scope_records (claim_id);

ALTER TABLE public.scope_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "homeowner_read_own_scope_records" ON public.scope_records;
CREATE POLICY "homeowner_read_own_scope_records"
  ON public.scope_records
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = scope_records.claim_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "admin_read_scope_records" ON public.scope_records;
CREATE POLICY "admin_read_scope_records"
  ON public.scope_records
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');
