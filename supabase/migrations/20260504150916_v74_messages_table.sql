-- Migration: v74_messages_table
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-04T15:09:16Z, recorded in
-- supabase_migrations.schema_migrations as version 20260504150916, name
-- "v74_messages_table". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.


CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('homeowner', 'contractor')),
  body TEXT NOT NULL CHECK (char_length(body) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_claim_id ON messages(claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Homeowner can read/write messages on their own claims (claims.user_id = homeowner)
CREATE POLICY "homeowner_messages" ON messages
  USING (
    claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid())
  )
  WITH CHECK (
    sender_id = auth.uid() AND sender_role = 'homeowner'
    AND claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid())
  );

-- Contractor can read/write messages on claims where they have a quote
CREATE POLICY "contractor_messages" ON messages
  USING (
    claim_id IN (
      SELECT claim_id FROM quotes WHERE contractor_id = (
        SELECT id FROM contractors WHERE user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    sender_id = auth.uid() AND sender_role = 'contractor'
    AND claim_id IN (
      SELECT claim_id FROM quotes WHERE contractor_id = (
        SELECT id FROM contractors WHERE user_id = auth.uid()
      )
    )
  );

-- Service role can read all (for Edge Function notifications)
CREATE POLICY "service_role_messages" ON messages
  USING (auth.role() = 'service_role');
