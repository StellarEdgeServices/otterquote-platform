-- Migration: v82_d182_retroactive_members_table.sql
-- Author: Wingman F-22 (wm-86e1f9q4a-a7c2)
-- Date: 2026-05-19
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: v82_d182_retroactive_members_table_rollback.sql
-- Pre-flight: v82_d182_retroactive_members_table_pre-flight.md
--
-- Summary: Retroactive migration filing for the `members` table.
-- This table exists in production (yeszghaspzwwstvsrioa) but had no migration file.
-- Discovered during v81 D-182 retroactive view migration (task 86e1f61ef, 2026-05-19).
-- Row count at time of filing: 0 (table is empty — no data loss risk from rollback).
-- Filing as idempotent CREATE TABLE IF NOT EXISTS for D-182 compliance.

BEGIN;

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    TEXT          NOT NULL,
  last_name     TEXT          NOT NULL,
  email         TEXT          NOT NULL,
  email_domain  TEXT,
  organization  TEXT,
  title         TEXT,
  phone         TEXT,
  state         TEXT          NOT NULL,
  referred_by   TEXT          NOT NULL,
  contributions TEXT[]        DEFAULT '{}'::text[],
  top_concern   TEXT,
  registered_at TIMESTAMPTZ   DEFAULT now(),
  status        TEXT          DEFAULT 'active'::text,
  notes         TEXT,
  verified      BOOLEAN       DEFAULT false,
  updated_at    TIMESTAMPTZ   DEFAULT now()
);

-- ── Unique constraint on email (idempotent) ───────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name   = 'members'
      AND constraint_name = 'members_email_key'
  ) THEN
    ALTER TABLE members ADD CONSTRAINT members_email_key UNIQUE (email);
  END IF;
END $$;

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- Policy: Allow public INSERT (registration)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'members'
      AND policyname = 'Allow public registration'
  ) THEN
    CREATE POLICY "Allow public registration"
      ON members FOR INSERT TO public
      WITH CHECK (true);
  END IF;
END $$;

-- Policy: Block public SELECT
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'members'
      AND policyname = 'Block public reads'
  ) THEN
    CREATE POLICY "Block public reads"
      ON members FOR SELECT TO public
      USING (false);
  END IF;
END $$;

COMMIT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Note: indexes run outside the transaction block.
-- CONCURRENTLY not used: table has 0 rows at time of filing (confirmed 2026-05-19).
-- All IF NOT EXISTS — safe no-ops on production where these indexes already exist.
CREATE INDEX IF NOT EXISTS idx_members_email         ON members (email);
CREATE INDEX IF NOT EXISTS idx_members_state          ON members (state);
CREATE INDEX IF NOT EXISTS idx_members_referred_by    ON members (referred_by);
CREATE INDEX IF NOT EXISTS idx_members_registered_at  ON members (registered_at);
CREATE INDEX IF NOT EXISTS idx_members_email_domain   ON members (email_domain);
