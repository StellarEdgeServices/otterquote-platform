-- ============================================================================
-- OtterQuote Referral System Migration
-- ============================================================================
-- Created: 2026-03-23
-- Purpose: Establish referral tracking infrastructure for agent partnerships
--
-- Tables:
--   - referral_agents: People who refer customers (RE agents, insurance agents, etc.)
--   - referrals: Individual referral tracking and commission management
--
-- Modifications to existing tables:
--   - claims: Add referral_code and referral_id columns
--
-- Functions:
--   - generate_referral_code(): Creates random 8-char alphanumeric codes
--   - update_referral_stats(): Updates agent statistics on commission changes
--
-- Triggers:
--   - referral_agents_generate_code: Auto-generates unique_code on insert
--   - referrals_update_stats: Updates agent stats when referral status changes
--
-- RLS Policies:
--   - referral_agents: Self-read/update + public read for active agents
--   - referrals: Agents read own referrals + service role full access
-- ============================================================================

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: referral_agents
-- Description: Tracks referral sources including RE agents, insurance agents,
--              home inspectors, and customer referrals
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.referral_agents (
  -- Identifiers
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Agent type and basic info
  agent_type TEXT NOT NULL
    CHECK (agent_type IN ('re_agent', 'insurance_agent', 'home_inspector', 'customer')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,

  -- Organization info
  company TEXT,

  -- Profile content
  photo_url TEXT,
  bio TEXT,
  website TEXT,
  service_area TEXT,

  -- Referral code for tracking
  unique_code TEXT NOT NULL UNIQUE,

  -- Status and timeline
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended')),
  onboarded_at TIMESTAMPTZ,

  -- Commission tracking
  total_referrals INTEGER DEFAULT 0,
  total_commission_earned DECIMAL(10,2) DEFAULT 0,
  total_commission_paid DECIMAL(10,2) DEFAULT 0,

  -- Link to OtterQuote user account (optional)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Flexible metadata storage
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Create indexes on referral_agents
CREATE INDEX idx_referral_agents_unique_code ON public.referral_agents(unique_code);
CREATE INDEX idx_referral_agents_email ON public.referral_agents(email);
CREATE INDEX idx_referral_agents_agent_type ON public.referral_agents(agent_type);

-- ============================================================================
-- TABLE: referrals
-- Description: Tracks individual referrals with commission calculation and
--              funnel stage monitoring
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.referrals (
  -- Identifiers
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Relationships
  referral_agent_id UUID NOT NULL REFERENCES public.referral_agents(id) ON DELETE CASCADE,
  claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,

  -- Homeowner contact info
  homeowner_name TEXT,
  homeowner_email TEXT,
  homeowner_phone TEXT,

  -- Referral lifecycle and commission
  status TEXT NOT NULL DEFAULT 'clicked'
    CHECK (status IN ('clicked', 'registered', 'claim_submitted', 'bid_received',
                      'contract_signed', 'job_completed', 'commission_paid')),
  job_value DECIMAL(12,2),
  commission_amount DECIMAL(10,2),
  commission_paid_at TIMESTAMPTZ,

  -- Traffic attribution
  landing_page TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,

  -- Flexible metadata storage
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Create indexes on referrals
CREATE INDEX idx_referrals_referral_agent_id ON public.referrals(referral_agent_id);
CREATE INDEX idx_referrals_status ON public.referrals(status);

-- ============================================================================
-- MODIFY EXISTING TABLE: claims
-- Description: Add referral tracking columns to link claims to referrals
-- ============================================================================
ALTER TABLE public.claims
ADD COLUMN IF NOT EXISTS referral_code TEXT,
ADD COLUMN IF NOT EXISTS referral_id UUID REFERENCES public.referrals(id) ON DELETE SET NULL;

-- Create index on claims for referral lookups
CREATE INDEX IF NOT EXISTS idx_claims_referral_code ON public.claims(referral_code);

-- ============================================================================
-- FUNCTION: generate_referral_code()
-- Description: Generates a random 8-character alphanumeric code for referral
--              tracking. Uses uppercase letters and numbers for readability.
-- Returns: TEXT (8-character code)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TEXT AS $$
DECLARE
  code TEXT;
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  i INT := 0;
BEGIN
  code := '';
  WHILE i < 8 LOOP
    code := code || substr(chars, (random() * length(chars))::INT + 1, 1);
    i := i + 1;
  END LOOP;
  RETURN code;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: update_referral_stats()
-- Description: Updates referral_agents statistics (total_referrals and
--              total_commission_earned) when a referral reaches certain
--              milestones, particularly when commission is paid.
-- Called by: referrals_update_stats trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_referral_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Update agent stats when referral status changes
  -- Increment total_referrals on first status change from 'clicked'
  IF OLD.status = 'clicked' AND NEW.status != 'clicked' THEN
    UPDATE public.referral_agents
    SET total_referrals = total_referrals + 1
    WHERE id = NEW.referral_agent_id;
  END IF;

  -- Update commission tracking when status changes to 'commission_paid'
  IF NEW.status = 'commission_paid' AND OLD.status != 'commission_paid' THEN
    UPDATE public.referral_agents
    SET
      total_commission_earned = total_commission_earned + COALESCE(NEW.commission_amount, 0),
      total_commission_paid = total_commission_paid + COALESCE(NEW.commission_amount, 0)
    WHERE id = NEW.referral_agent_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER FUNCTION: referral_agents_generate_code()
-- Description: Auto-generates unique_code if not provided on insert.
--              Uses BEFORE INSERT trigger to assign to NEW.unique_code.
-- Table: referral_agents
-- ============================================================================
CREATE OR REPLACE FUNCTION public.referral_agents_generate_code()
RETURNS TRIGGER AS $$
DECLARE
  code TEXT;
BEGIN
  IF NEW.unique_code IS NULL THEN
    -- Keep generating until we get a unique code
    LOOP
      code := public.generate_referral_code();
      EXIT WHEN NOT EXISTS(SELECT 1 FROM public.referral_agents WHERE unique_code = code);
    END LOOP;
    NEW.unique_code := code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER referral_agents_generate_code
BEFORE INSERT ON public.referral_agents
FOR EACH ROW
EXECUTE FUNCTION public.referral_agents_generate_code();

-- ============================================================================
-- TRIGGER: referrals_update_stats
-- Description: Updates referral agent stats when referral status changes
-- Table: referrals
-- ============================================================================
CREATE TRIGGER referrals_update_stats
AFTER UPDATE ON public.referrals
FOR EACH ROW
EXECUTE FUNCTION public.update_referral_stats();

-- ============================================================================
-- RLS: Enable Row Level Security
-- ============================================================================
ALTER TABLE public.referral_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES: referral_agents
-- ============================================================================
-- Policy 1: Agents can read and update their own profile (linked via user_id)
CREATE POLICY "Agents can manage own profile"
  ON public.referral_agents
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Policy 2: Public can read active agents (for landing page personalization)
CREATE POLICY "Public can read active agents"
  ON public.referral_agents
  FOR SELECT
  USING (status = 'active');

-- Policy 3: Service role can perform all operations (for admin/system tasks)
CREATE POLICY "Service role full access"
  ON public.referral_agents
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- RLS POLICIES: referrals
-- ============================================================================
-- Policy 1: Referral agents can read their own referrals
CREATE POLICY "Agents can read own referrals"
  ON public.referrals
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.referral_agents
      WHERE id = referrals.referral_agent_id
        AND user_id = auth.uid()
    )
  );

-- Policy 2: Service role can perform all operations
CREATE POLICY "Service role full access"
  ON public.referrals
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE public.referral_agents IS
'Tracks referral sources: RE agents, insurance agents, home inspectors, and customers. Stores profile info and commission statistics.';

COMMENT ON COLUMN public.referral_agents.unique_code IS
'Short alphanumeric code used in referral URLs (e.g., otterquote.com/join/ABC12345)';

COMMENT ON COLUMN public.referral_agents.agent_type IS
'Type of referral source: re_agent, insurance_agent, home_inspector, or customer';

COMMENT ON COLUMN public.referral_agents.user_id IS
'Optional link to OtterQuote user account if agent creates login credentials';

COMMENT ON COLUMN public.referral_agents.metadata IS
'Flexible JSONB storage for agent-specific data, customization preferences, etc.';

COMMENT ON TABLE public.referrals IS
'Individual referral tracking with commission calculation based on job value. Follows customer through claim submission and job completion.';

COMMENT ON COLUMN public.referrals.status IS
'Referral funnel stage: clicked → registered → claim_submitted → bid_received → contract_signed → job_completed → commission_paid';

COMMENT ON COLUMN public.referrals.commission_amount IS
'Calculated as: $250 if job_value > $10,000; $0 otherwise';

COMMENT ON COLUMN public.referrals.utm_source IS
'Traffic attribution: utm_source parameter from referral URL';

COMMENT ON COLUMN public.referrals.metadata IS
'Flexible JSONB storage for additional referral context or tracking data';

COMMENT ON COLUMN public.claims.referral_code IS
'The unique referral code from the referral_agents table that led to this claim';

COMMENT ON COLUMN public.claims.referral_id IS
'Foreign key reference to the referrals table entry for this claim';

COMMENT ON FUNCTION public.generate_referral_code() IS
'Generates an 8-character random alphanumeric code (A-Z, 0-9) for referral tracking URLs';

COMMENT ON FUNCTION public.update_referral_stats() IS
'Triggered on referral status changes to update agent stats: increments total_referrals on status change, increments total_commission_earned on commission_paid';

-- ============================================================================
-- End of Migration
-- ============================================================================
