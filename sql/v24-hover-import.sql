-- ============================================================
-- OtterQuote v24 Migration: Stohler Roofing Hover Import
-- Applied: April 9, 2026 — Session 100
-- Purpose: Store metadata from Stohler Roofing's historical Hover jobs
--          for homeowner outreach / OtterQuote platform invitations.
--          Metadata only — no PDFs, no XLSX. Files fetched on-demand.
-- ============================================================

-- 1. Create the imported_hover_jobs table
CREATE TABLE IF NOT EXISTS imported_hover_jobs (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Hover identifiers
  hover_job_id        INTEGER       UNIQUE NOT NULL,
  hover_job_name      TEXT,                           -- Hover's label/name for the job

  -- Property address (flattened from Hover location object)
  full_address        TEXT,
  address_line1       TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,

  -- Primary contact on the job (homeowner / property owner)
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,

  -- Job status / lifecycle dates from Hover
  hover_status        TEXT,                           -- e.g. 'complete', 'processing', 'pending'
  hover_created_at    TIMESTAMPTZ,
  hover_completed_at  TIMESTAMPTZ,

  -- Raw JSON snapshot of the Hover API response (no file download URLs)
  raw_metadata        JSONB,

  -- OtterQuote outreach tracking
  outreach_status     TEXT          NOT NULL DEFAULT 'pending',
  -- values: 'pending' | 'contacted' | 'joined' | 'declined' | 'undeliverable'
  outreach_notes      TEXT,

  -- Housekeeping
  imported_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. Useful indexes
CREATE INDEX IF NOT EXISTS idx_imported_hover_jobs_hover_job_id
  ON imported_hover_jobs (hover_job_id);

CREATE INDEX IF NOT EXISTS idx_imported_hover_jobs_contact_email
  ON imported_hover_jobs (contact_email);

CREATE INDEX IF NOT EXISTS idx_imported_hover_jobs_outreach_status
  ON imported_hover_jobs (outreach_status);

CREATE INDEX IF NOT EXISTS idx_imported_hover_jobs_raw_metadata
  ON imported_hover_jobs USING GIN (raw_metadata);

-- 3. RLS — no public access; service role only (Edge Functions + import scripts)
ALTER TABLE imported_hover_jobs ENABLE ROW LEVEL SECURITY;

-- 4. Convenience: add account_label to hover_tokens so we can distinguish
--    OtterQuote's live token from any temporary import token
ALTER TABLE hover_tokens
  ADD COLUMN IF NOT EXISTS account_label TEXT DEFAULT 'otterquote';

-- 5. Back-fill existing OtterQuote token row
UPDATE hover_tokens
  SET account_label = 'otterquote'
  WHERE account_label IS NULL;

-- ============================================================
-- DONE. Run the Stohler import script to populate the table.
-- ============================================================
