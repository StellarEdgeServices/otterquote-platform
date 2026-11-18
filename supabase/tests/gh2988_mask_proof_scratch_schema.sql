-- gh-2988 proof: SCRATCH-ONLY stub schema (just enough tables for public.bidder_claim_summary to compile). Throwaway Postgres only; never run against production.
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.carrier_profiles (id uuid PRIMARY KEY, carrier_name text);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, status text, is_test boolean DEFAULT false);
CREATE TABLE public.claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, ready_for_bids boolean, created_at timestamptz DEFAULT now(),
 trades text[], job_type text, funding_type text, damage_type text, material_category text, shingle_type text, impact_class text,
 designer_product text, designer_manufacturer text, existing_shingle_brand text, existing_shingle_color text,
 rcv_amount numeric(10,2), acv_amount numeric(10,2), deductible_amount numeric(10,2), roof_squares numeric(6,1), repair_squares numeric(6,1),
 hover_measurements jsonb, measurement_shape text, parsed_line_items jsonb, contractor_scope_summary text, urgency text, urgency_deadline date,
 selected_contractor_id uuid, platform_fee_charged boolean DEFAULT false, homeowner_notes text, roofing_bid_released_at timestamptz,
 gutters_bid_released_at timestamptz, siding_bid_released_at timestamptz, windows_bid_released_at timestamptz, bid_window_expires_at timestamptz,
 estimate_filename text, has_estimate boolean, measurements_filename text, has_measurements boolean, property_city text, property_address text,
 property_zip text, carrier_id uuid, homeowner_name text, claim_number text, is_test boolean DEFAULT false, loss_sheet_parsed_at timestamptz);
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, contractor_id uuid);
