-- ============================================================
-- v99 — scope_records: frozen Exhibit A Section 1 storage (#588 Phase 1)
-- Tier 3A (additive: new table + indexes + RLS on the new table only).
-- Rollback: v99-rollback-scope-records.sql
--
-- Locked decision #4 (2026-07-30): Section 1 is stored as structured JSON
-- with a content hash, never recomputed, rendered verbatim everywhere.
-- Locked decision #6: persistence is structured data + versioned.
-- Catalog amendment #1 (2026-07-31): the hash covers PURE MEASURED values —
-- waste-adjusted install quantities are render-time only and never stored.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scope_records (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         UUID        NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  trade            TEXT        NOT NULL DEFAULT 'roofing',
  catalog_version  TEXT        NOT NULL,
  scope_json       JSONB       NOT NULL,
  content_hash     TEXT        NOT NULL,          -- SHA-256 hex of canonical measured-values payload
  version          INTEGER     NOT NULL DEFAULT 1,
  source           TEXT,                          -- 'pdf_parse' | 'hover_api'
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at    TIMESTAMPTZ                    -- non-null only via D-203 change order
);

-- Exactly one ACTIVE frozen scope per claim+trade (generate-once semantics).
CREATE UNIQUE INDEX IF NOT EXISTS scope_records_active_uniq
  ON public.scope_records (claim_id, trade)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS scope_records_claim_idx
  ON public.scope_records (claim_id);

ALTER TABLE public.scope_records ENABLE ROW LEVEL SECURITY;

-- Homeowner: read own claim's scope records (dashboard release-gate check).
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

-- Admin read (matches platform_alerts_log admin pattern).
DROP POLICY IF EXISTS "admin_read_scope_records" ON public.scope_records;
CREATE POLICY "admin_read_scope_records"
  ON public.scope_records
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');

-- All writes are service-role only (Edge Functions); no INSERT/UPDATE/DELETE
-- policies for authenticated/anon. Service role bypasses RLS.
