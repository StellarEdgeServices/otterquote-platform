-- ============================================================
-- ClaimShield v4 — Dashboard Bug Fixes Migration
-- Run in Supabase SQL Editor
-- ============================================================
-- Adds columns referenced by dashboard.html that were missing
-- from the v2 migration. Safe to run multiple times.
-- ============================================================

-- ── 1. Add missing filename columns to claims ──────────────
-- Dashboard stores the original filename when homeowner uploads
-- estimate or measurement documents.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='estimate_filename') THEN
    ALTER TABLE claims ADD COLUMN estimate_filename TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='measurements_filename') THEN
    ALTER TABLE claims ADD COLUMN measurements_filename TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='date_of_loss') THEN
    ALTER TABLE claims ADD COLUMN date_of_loss DATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='damage_type') THEN
    ALTER TABLE claims ADD COLUMN damage_type TEXT DEFAULT 'roof';
  END IF;
END $$;

-- ── 2. Create profiles trigger ─────────────────────────────
-- Auto-create a profile row when a new user signs up via
-- Supabase Auth, so dashboard.html never hits a missing profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, address_state, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    'IN',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop if exists, then recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
