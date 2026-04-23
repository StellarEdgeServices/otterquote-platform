-- ── v50 — CPA Version Tracking ────────────────────────────────────────────
--
-- Adds per-contractor CPA version tracking so the platform can detect when
-- an existing contractor has not yet accepted a newer version of the
-- Contractor Partner Agreement and prompt re-acceptance.
--
-- Changes:
--   1. Add cpa_version TEXT to contractors
--   2. Add cpa_accepted_at TIMESTAMPTZ to contractors
--   3. Backfill existing contractors to cpa_version = 'v1-2026-04',
--      cpa_accepted_at = COALESCE(attestation_accepted_at, NOW())
--   4. Add record_cpa_ip() SECURITY DEFINER function — stamps server-side IP
--      into ic_24511_attestation JSONB under the 'cpa_reaccept' key, preserving
--      the original IC 24-5-11 signing IP untouched.

-- ── 1. Add columns ──────────────────────────────────────────────────────────

-- DEFAULT 'v1-2026-04' on cpa_version ensures new contractor rows created after
-- this migration automatically have the current version stamped — they will not
-- see the re-acceptance modal on first login.
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS cpa_version     TEXT DEFAULT 'v1-2026-04',
  ADD COLUMN IF NOT EXISTS cpa_accepted_at TIMESTAMPTZ;

-- ── 2. Backfill existing contractors ───────────────────────────────────────
-- All contractors who exist today have already accepted the CPA (either via
-- click-wrap prior to DocuSign migration, or via DocuSign post-D-152).
-- We stamp them as 'v1-2026-04' so they are NOT prompted to re-accept on
-- first load after this migration deploys.
--
-- cpa_accepted_at: use their attestation_accepted_at where available
-- (closest proxy for when they first signed), otherwise NOW().

-- Note: cpa_version is already set by the column DEFAULT above for all existing rows,
-- so the cpa_version set here is a no-op. The important backfill is cpa_accepted_at,
-- which has no DEFAULT and must be populated for every pre-existing row.
UPDATE contractors
SET
  cpa_version     = 'v1-2026-04',
  cpa_accepted_at = COALESCE(attestation_accepted_at, NOW())
WHERE cpa_accepted_at IS NULL;

-- ── 3. record_cpa_ip() SECURITY DEFINER function ───────────────────────────
-- Called client-side immediately after a contractor accepts a new CPA version.
-- Reads the real client IP from request headers (spoof-resistant — header is
-- injected by Supabase's edge layer, not the browser) and appends it to the
-- ic_24511_attestation JSONB under a 'cpa_reaccept' key.
--
-- This deliberately does NOT overwrite the original 'accepted_ip' /
-- 'accepted_ua' / 'accepted_at' keys, which record the IC 24-5-11 attestation
-- at contractor join time. Both audit trails are preserved.
--
-- The cpa_version and cpa_accepted_at columns are written directly by the
-- client (covered by the existing "Contractors can update own record" RLS
-- policy). This function only handles the IP stamp.

CREATE OR REPLACE FUNCTION record_cpa_ip(p_contractor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip      TEXT;
  v_ua      TEXT;
  v_headers JSONB;
BEGIN
  -- Authorization: only allow a contractor to stamp their own record
  IF NOT EXISTS (
    SELECT 1 FROM contractors
    WHERE id        = p_contractor_id
      AND user_id   = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for contractor %', p_contractor_id;
  END IF;

  -- Extract IP + UA from Supabase request headers
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  -- Append cpa_reaccept object to ic_24511_attestation JSONB.
  -- Uses || (object merge) so all existing keys are preserved.
  UPDATE contractors
  SET ic_24511_attestation =
        COALESCE(ic_24511_attestation, '{}'::jsonb)
        || jsonb_build_object(
             'cpa_reaccept', jsonb_build_object(
               'accepted_ip',  v_ip,
               'accepted_ua',  v_ua,
               'accepted_at',  NOW()
             )
           )
  WHERE id = p_contractor_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_cpa_ip(uuid) TO authenticated;

-- ── 4. Verification ─────────────────────────────────────────────────────────
-- After applying, confirm columns exist and backfill ran:
--
--   SELECT id, cpa_version, cpa_accepted_at
--   FROM contractors
--   LIMIT 5;
--
-- Expected: all rows show cpa_version = 'v1-2026-04' and a non-null timestamp.
--
-- To test the re-acceptance modal, manually set one test contractor:
--
--   UPDATE contractors SET cpa_version = 'v0-test'
--   WHERE id = '<test-contractor-id>';
--
-- Then load contractor-dashboard.html — the CPA re-acceptance modal should appear.
