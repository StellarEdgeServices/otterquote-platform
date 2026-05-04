-- v74: Add messages table for in-platform contractor-homeowner messaging (86e0v8c45, 2026-05-04)

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('homeowner', 'contractor')),
  body TEXT NOT NULL CHECK (char_length(body) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX idx_messages_claim_id ON messages(claim_id, created_at DESC);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);

-- RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Homeowner can read/write messages on their own claims
CREATE POLICY "homeowner_messages" ON messages
  USING (
    claim_id IN (SELECT id FROM claims WHERE homeowner_id = auth.uid())
  )
  WITH CHECK (
    sender_id = auth.uid() AND sender_role = 'homeowner'
    AND claim_id IN (SELECT id FROM claims WHERE homeowner_id = auth.uid())
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
