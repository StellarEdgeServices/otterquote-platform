-- v84_drop_orphan_tables_rollback.sql
-- Rollback for: Drop four orphaned tables (v84_drop_orphan_tables.sql)
-- ClickUp: 86e1j588x
--
-- Restores tables to their pre-drop schema (column defs + PKs + indexes +
-- RLS policies + triggers) as captured 2026-05-27 from live Supabase.
-- Restored tables are empty — original rows were already zero, so no data
-- restoration is performed.
--
-- IMPORTANT: This rollback recreates the schema only. Application code
-- targeting these tables (e.g., schedule-inspection.html line 997 →
-- inspection_bookings) was never moved off the orphan tables, so rollback
-- restores baseline behavior. No application redeploy required after rollback.

BEGIN;

-- ============================================================
-- documents
-- ============================================================
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL,
  user_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  doc_category TEXT DEFAULT 'other'::text,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT documents_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_documents_claim_id ON public.documents (claim_id);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own documents" ON public.documents
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own documents" ON public.documents
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own documents" ON public.documents
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- job_assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.job_assignments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL,
  quote_id UUID NOT NULL,
  contractor_id UUID NOT NULL,
  homeowner_id UUID NOT NULL,
  quoted_price NUMERIC NOT NULL,
  fee_percentage NUMERIC NOT NULL,
  fee_amount NUMERIC NOT NULL,
  fee_status TEXT DEFAULT 'pending'::text,
  stripe_charge_id TEXT,
  contract_signed BOOLEAN DEFAULT false,
  contract_signed_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending_contract'::text,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT job_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT job_assignments_claim_id_key UNIQUE (claim_id)
);
CREATE INDEX IF NOT EXISTS idx_job_assignments_claim_id ON public.job_assignments (claim_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_contractor_id ON public.job_assignments (contractor_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_quote_id ON public.job_assignments (quote_id);

ALTER TABLE public.job_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Homeowners can read own assignments" ON public.job_assignments
  FOR SELECT USING (auth.uid() = homeowner_id);
CREATE POLICY "Homeowners can insert assignments" ON public.job_assignments
  FOR INSERT WITH CHECK (auth.uid() = homeowner_id);
CREATE POLICY "Contractors can read their assignments" ON public.job_assignments
  FOR SELECT USING (auth.uid() = contractor_id);

-- trigger: set_updated_at_job_assignments
-- Assumes set_updated_at() helper function exists (created by earlier migration)
CREATE TRIGGER set_updated_at_job_assignments
  BEFORE UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- inspection_bookings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inspection_bookings (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL,
  contractor_id UUID,
  homeowner_id UUID NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_time TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled'::text,
  inspection_type TEXT,
  inspection_fee NUMERIC DEFAULT 0,
  homeowner_guarantee_paid BOOLEAN DEFAULT false,
  contractor_penalty_charged BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT inspection_bookings_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_claim ON public.inspection_bookings (claim_id);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_contractor ON public.inspection_bookings (contractor_id);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_date ON public.inspection_bookings (scheduled_date);

ALTER TABLE public.inspection_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Homeowners can view own bookings" ON public.inspection_bookings
  FOR SELECT USING (auth.uid() = homeowner_id);
CREATE POLICY "Homeowners can create bookings" ON public.inspection_bookings
  FOR INSERT WITH CHECK (auth.uid() = homeowner_id);
CREATE POLICY "Contractors can view assigned bookings" ON public.inspection_bookings
  FOR SELECT USING (auth.uid() = contractor_id);
CREATE POLICY "Contractors can update assigned bookings" ON public.inspection_bookings
  FOR UPDATE USING (auth.uid() = contractor_id);

-- ============================================================
-- claim_trade_items
-- ============================================================
CREATE TABLE IF NOT EXISTS public.claim_trade_items (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  claim_id UUID,
  trade TEXT NOT NULL,
  scope TEXT,
  estimated_amount NUMERIC,
  depreciation_amount NUMERIC,
  sides_affected TEXT,
  homeowner_decision TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT claim_trade_items_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_claim_trade_items_claim_id ON public.claim_trade_items (claim_id);

ALTER TABLE public.claim_trade_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Homeowners can view own claim trade items" ON public.claim_trade_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.claims c WHERE c.id = claim_id AND c.homeowner_id = auth.uid())
  );
CREATE POLICY "Homeowners can update own claim trade items" ON public.claim_trade_items
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.claims c WHERE c.id = claim_id AND c.homeowner_id = auth.uid())
  );
CREATE POLICY "Service role full access to claim_trade_items" ON public.claim_trade_items
  FOR ALL USING (auth.role() = 'service_role');

COMMIT;
