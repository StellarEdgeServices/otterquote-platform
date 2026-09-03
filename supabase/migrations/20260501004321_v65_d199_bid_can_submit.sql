-- Migration: v65_d199_bid_can_submit
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T00:43:21Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501004321, name
-- "v65_d199_bid_can_submit". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- D-199 bid-time validation gate (Tier 3, Session 463)
-- Blocks quote insert/update unless contractor has a validated template for the bid's trade × funding_type.
-- Companion rollback: sql/v65-rollback-d199-bid-can-submit.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Predicate function — usable by client (RPC) and server (trigger)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bid_can_submit(
  p_contractor_id uuid,
  p_trade text,
  p_funding_type text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_reason text;
  v_can_submit boolean := false;
BEGIN
  -- Input validation
  IF p_contractor_id IS NULL THEN
    RETURN jsonb_build_object('can_submit', false, 'reason', 'contractor_id required', 'status', NULL);
  END IF;
  IF p_trade IS NULL OR length(trim(p_trade)) = 0 THEN
    RETURN jsonb_build_object('can_submit', false, 'reason', 'trade required', 'status', NULL);
  END IF;
  IF p_funding_type IS NULL OR length(trim(p_funding_type)) = 0 THEN
    RETURN jsonb_build_object('can_submit', false, 'reason', 'funding_type required', 'status', NULL);
  END IF;

  -- Look up the contractor_templates row for this slot (case-insensitive)
  SELECT status INTO v_status
  FROM public.contractor_templates
  WHERE contractor_id = p_contractor_id
    AND lower(trade) = lower(p_trade)
    AND lower(funding_type) = lower(p_funding_type)
  LIMIT 1;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object(
      'can_submit', false,
      'reason', 'Your contract template for ' || initcap(p_trade) || ' / ' || initcap(p_funding_type) || ' has not been uploaded yet. Upload and validate it on your profile before bidding.',
      'status', 'not_found'
    );
  END IF;

  -- Status mapping (matches js/contract-template-validation.js status set)
  CASE v_status
    WHEN 'auto_validated', 'manual_validated', 'admin_validated' THEN
      v_can_submit := true;
      v_reason := NULL;
    WHEN 'pending_validation' THEN
      v_reason := 'Your contract template for ' || initcap(p_trade) || ' / ' || initcap(p_funding_type) || ' is still being validated. Refresh in a moment or check your profile.';
    WHEN 'manual_mapping_pending' THEN
      v_reason := 'Your contract template for ' || initcap(p_trade) || ' / ' || initcap(p_funding_type) || ' needs your action — please complete the manual anchor mapping on your profile.';
    WHEN 'submitted_for_admin_review' THEN
      v_reason := 'Your contract template for ' || initcap(p_trade) || ' / ' || initcap(p_funding_type) || ' is in admin review. You will be notified once approved.';
    WHEN 'rejected' THEN
      v_reason := 'Your contract template for ' || initcap(p_trade) || ' / ' || initcap(p_funding_type) || ' was rejected. Please re-upload a corrected template on your profile.';
    ELSE
      v_reason := 'Template status (' || v_status || ') does not permit bidding. Contact support if you believe this is an error.';
  END CASE;

  RETURN jsonb_build_object(
    'can_submit', v_can_submit,
    'reason', v_reason,
    'status', v_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bid_can_submit(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bid_can_submit(uuid, text, text) TO service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Enforcement trigger function — server-side teeth for D-199
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_bid_can_submit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade text;
  v_funding_type text;
  v_job_type text;
  v_funding_col text;
  v_result jsonb;
BEGIN
  -- Skip enforcement for auto-bids (validated by their own pipeline)
  IF NEW.is_auto_bid IS TRUE THEN
    RETURN NEW;
  END IF;

  -- Resolve trade from the row
  v_trade := lower(coalesce(NEW.trade_type, 'roofing'));

  -- Resolve funding_type from the linked claim
  -- claims may have funding_type column OR may infer from job_type ('insurance_*' -> insurance, 'retail'/'cash' -> retail)
  SELECT
    lower(coalesce(c.funding_type, '')) AS funding_col,
    lower(coalesce(c.job_type, '')) AS job_type_col
  INTO v_funding_col, v_job_type
  FROM public.claims c
  WHERE c.id = NEW.claim_id
  LIMIT 1;

  IF v_funding_col IS NOT NULL AND length(v_funding_col) > 0 THEN
    v_funding_type := v_funding_col;
  ELSIF v_job_type LIKE 'insurance%' THEN
    v_funding_type := 'insurance';
  ELSIF v_job_type IN ('retail', 'cash') THEN
    v_funding_type := 'retail';
  ELSE
    -- Default conservatively to retail (D-202 fallback path)
    v_funding_type := 'retail';
  END IF;

  -- Normalize: contractor_templates uses 'insurance' / 'retail'
  IF v_funding_type LIKE 'insurance%' THEN v_funding_type := 'insurance'; END IF;
  IF v_funding_type IN ('cash', 'out_of_pocket') THEN v_funding_type := 'retail'; END IF;

  -- Run the predicate
  v_result := public.bid_can_submit(NEW.contractor_id, v_trade, v_funding_type);

  IF (v_result->>'can_submit')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'D-199 bid gate: %', coalesce(v_result->>'reason', 'Template not validated')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Attach trigger to quotes table (BEFORE INSERT only — UPDATE of trade_type/claim_id is rare)
-- ──────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS quotes_enforce_bid_can_submit ON public.quotes;

CREATE TRIGGER quotes_enforce_bid_can_submit
BEFORE INSERT ON public.quotes
FOR EACH ROW
EXECUTE FUNCTION public.enforce_bid_can_submit();

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. Comments for self-documentation
-- ──────────────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.bid_can_submit(uuid, text, text) IS
  'D-199 bid-time validation predicate. Returns {can_submit, reason, status}. Used by contractor-bid-form.html client gate AND quotes_enforce_bid_can_submit trigger. Rollback: sql/v65-rollback-d199-bid-can-submit.sql';

COMMENT ON FUNCTION public.enforce_bid_can_submit() IS
  'D-199 trigger function. Resolves trade + funding_type and raises EXCEPTION P0001 if bid_can_submit returns false. Skips enforcement for is_auto_bid=true rows. Session 463, Apr 30, 2026.';

COMMENT ON TRIGGER quotes_enforce_bid_can_submit ON public.quotes IS
  'D-199 bid-time gate (Session 463, Apr 30, 2026). Blocks INSERTs unless contractor has a validated template for the bid trade × funding_type.';
