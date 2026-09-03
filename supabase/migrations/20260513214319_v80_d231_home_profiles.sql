-- Migration: v80_d231_home_profiles
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-13T21:43:19Z, recorded in
-- supabase_migrations.schema_migrations as version 20260513214319, name
-- "v80_d231_home_profiles". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v80: D-231 — Post-completion homeowner home profile prompt (Lodge data moat)
-- Creates: home_profiles table + claims.profile_prompt_sent_at column
-- Adds:    RLS policies, updated_at trigger, rate_limit_config entry, pg_cron schedule (see below)
-- Applied: 2026-05-13
-- Rollback: v80-rollback-d231-home-profiles.sql

-- ─── 1. home_profiles table ──────────────────────────────────────────────────
--
-- One row per homeowner (UNIQUE on homeowner_user_id).
-- Required fields: year_built, square_footage, stories, future_projects
-- Optional fields: roof_last_replaced, siding_material, hvac_age_years, notes
-- stories uses TEXT (not smallint) because the UI option set includes '1.5' and '3+'

CREATE TABLE IF NOT EXISTS public.home_profiles (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_user_id   UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Required fields (set on initial submission)
  year_built          INTEGER       NOT NULL CHECK (year_built BETWEEN 1800 AND 2100),
  square_footage      INTEGER       NOT NULL CHECK (square_footage > 0),
  stories             TEXT          NOT NULL CHECK (stories IN ('1', '1.5', '2', '3+')),
  future_projects     TEXT[]        NOT NULL DEFAULT '{}',

  -- Optional fields (expandable section in form)
  roof_last_replaced  INTEGER       NULL CHECK (roof_last_replaced BETWEEN 1800 AND 2100),
  siding_material     TEXT          NULL,
  hvac_age_years      SMALLINT      NULL CHECK (hvac_age_years >= 0),
  notes               TEXT          NULL,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT home_profiles_homeowner_user_id_unique UNIQUE (homeowner_user_id)
);

COMMENT ON TABLE public.home_profiles IS
  'D-231: One-row-per-homeowner home property profile. Feeds The Lodge data moat (D-205). '
  'Populated via post-completion prompt (email + in-app card). '
  'future_projects values: Roofing | Siding | Gutters | Windows | HVAC | Other.';

-- ─── 2. updated_at auto-update trigger ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.home_profiles_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS home_profiles_updated_at ON public.home_profiles;
CREATE TRIGGER home_profiles_updated_at
  BEFORE UPDATE ON public.home_profiles
  FOR EACH ROW EXECUTE FUNCTION public.home_profiles_set_updated_at();

-- ─── 3. Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS home_profiles_homeowner_user_id_idx
  ON public.home_profiles (homeowner_user_id);

CREATE INDEX IF NOT EXISTS home_profiles_future_projects_gin_idx
  ON public.home_profiles USING GIN (future_projects);

-- ─── 4. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.home_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Homeowners can view own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can view own home profile"
  ON public.home_profiles FOR SELECT
  USING (homeowner_user_id = auth.uid());

DROP POLICY IF EXISTS "Homeowners can create own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can create own home profile"
  ON public.home_profiles FOR INSERT
  WITH CHECK (homeowner_user_id = auth.uid());

DROP POLICY IF EXISTS "Homeowners can update own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can update own home profile"
  ON public.home_profiles FOR UPDATE
  USING (homeowner_user_id = auth.uid());

-- ─── 5. claims.profile_prompt_sent_at column ────────────────────────────────

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS profile_prompt_sent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.claims.profile_prompt_sent_at IS
  'D-231: Timestamp when the home profile prompt email was sent (or skipped because '
  'homeowner already had a home_profiles row). NULL = not yet sent. '
  'Idempotency gate for send-home-profile-prompt EF.';

CREATE INDEX IF NOT EXISTS claims_profile_prompt_pending_idx
  ON public.claims (completion_date)
  WHERE profile_prompt_sent_at IS NULL AND completion_date IS NOT NULL;

-- ─── 6. rate_limit_config entry ──────────────────────────────────────────────

INSERT INTO public.rate_limit_config (
  function_name,
  max_per_hour,
  max_per_day,
  max_per_month,
  enabled,
  monthly_cost_estimate,
  monthly_budget_cap,
  notes
)
VALUES (
  'send-home-profile-prompt',
  100,
  500,
  5000,
  true,
  0.50,
  10.00,
  'D-231: Hourly cron — sends Mailgun email 24h post job-completion to homeowners '
  'without a home_profiles row. Also called non-blocking by mark-job-complete.'
)
ON CONFLICT (function_name) DO NOTHING;
