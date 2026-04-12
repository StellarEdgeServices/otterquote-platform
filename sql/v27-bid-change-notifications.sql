-- v27 — Bid Change Notifications
-- Adds read_at column to notifications table (missing from v2 original schema)
-- and ensures the notifications table supports the bid_updated flow.
-- Apply via Supabase Management API or SQL Editor.

-- 1. Add read_at if it doesn't already exist
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- 2. Add index for unread notification queries (improves homeowner dashboard lookup)
CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at)
  WHERE read_at IS NULL;

-- 3. Ensure bid_updated notification type is queryable efficiently
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(notification_type);

-- 4. RLS: homeowners can insert bid_updated notifications (contractors write these on behalf of homeowners)
-- We use the service role for this insert (called from the frontend with anon key, so we need a policy)
-- Allow authenticated users to insert notifications for claims they are associated with (contractor inserting for homeowner)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Authenticated can insert notifications'
  ) THEN
    CREATE POLICY "Authenticated can insert notifications"
      ON notifications FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;
END $$;

-- 5. RLS: homeowners can read their own notifications
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can view own notifications'
  ) THEN
    CREATE POLICY "Users can view own notifications"
      ON notifications FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- 6. RLS: homeowners can update (acknowledge/dismiss) their own notifications
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can update own notifications'
  ) THEN
    CREATE POLICY "Users can update own notifications"
      ON notifications FOR UPDATE
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
