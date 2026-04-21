-- ============================================================
-- v46: D-170 — CGL COI upload + IC 24-5-11 attestation
-- Applied: (pending)
--
-- Context:
--   D-170 (Pre-Launch Audit, Session 251) requires every
--   contractor to (a) upload a current CGL Certificate of
--   Insurance naming Stellar Edge Services as additional
--   insured and (b) electronically sign an IC 24-5-11
--   self-attestation with joint-and-several indemnity to
--   Stellar before they can submit quotes. The ClickUp task
--   originally labeled "D-166" was mis-labeled in Session 251;
--   the actual D-166 is "no background checks." The CGL COI +
--   attestation requirement lives under D-170.
--
-- What this migration does:
--   1. Adds COI columns to contractors (file URL, expiry,
--      insurer, policy #, per-window reminder timestamps).
--   2. Adds attestation columns (JSONB audit payload +
--      top-level accepted-at for indexing).
--   3. Creates an expiry index for the nightly COI-expiry
--      sweep (30/14/7-day Mailgun reminders).
--   4. Defines contractor_can_bid(contractor_id) as a
--      SECURITY DEFINER function returning TRUE only if the
--      contractor is active, has a current COI (expires in
--      the future), and has an accepted attestation.
--   5. Replaces the quotes INSERT RLS policy to require
--      contractor_can_bid(contractor_id).
--
-- Safe to re-run: ADD COLUMN / CREATE INDEX use IF NOT EXISTS;
-- CREATE OR REPLACE FUNCTION is idempotent; DROP POLICY IF
-- EXISTS before CREATE POLICY.
-- ============================================================

-- ── 1. Add COI columns ──────────────────────────────────────

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS coi_file_url              TEXT,
  ADD COLUMN IF NOT EXISTS coi_expires_at            DATE,
  ADD COLUMN IF NOT EXISTS coi_insurer               TEXT,
  ADD COLUMN IF NOT EXISTS coi_policy_number         TEXT,
  ADD COLUMN IF NOT EXISTS coi_uploaded_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coi_reminder_30_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coi_reminder_14_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coi_reminder_7_sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coi_expired_notified_at   TIMESTAMPTZ;

-- ── 2. Add IC 24-5-11 attestation columns ───────────────────
-- Top-level columns for the hot-path gate query; JSONB for the
-- full audit payload (signer name, title, IP, user-agent, text
-- version hash, timestamp).

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS ic_24511_attestation      JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attestation_accepted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attestation_signer_name   TEXT,
  ADD COLUMN IF NOT EXISTS attestation_signer_title  TEXT,
  ADD COLUMN IF NOT EXISTS attestation_text_version  TEXT;

-- ── 3. Expiry index for nightly sweep ───────────────────────

CREATE INDEX IF NOT EXISTS idx_contractors_coi_expires
  ON contractors(coi_expires_at)
  WHERE coi_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contractors_attestation_accepted
  ON contractors(attestation_accepted_at)
  WHERE attestation_accepted_at IS NOT NULL;

-- ── 4. Eligibility function (SECURITY DEFINER, no RLS loop) ─

CREATE OR REPLACE FUNCTION contractor_can_bid(p_contractor_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM contractors c
    WHERE c.id = p_contractor_id
      AND c.status = 'active'
      AND c.coi_file_url IS NOT NULL
      AND c.coi_expires_at IS NOT NULL
      AND c.coi_expires_at > CURRENT_DATE
      AND c.attestation_accepted_at IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION contractor_can_bid(uuid) TO authenticated;

-- ── 4b. Server-side IP capture for attestation ──────────────
-- Supabase auto-populates request.headers; we read x-forwarded-for
-- at attestation time so the client can't spoof the IP. Called
-- once, right after the contractor row is inserted.

CREATE OR REPLACE FUNCTION record_attestation_ip(p_contractor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip TEXT;
  v_ua TEXT;
  v_headers JSONB;
BEGIN
  -- Only allow a contractor to stamp their own record
  IF NOT EXISTS (
    SELECT 1 FROM contractors
    WHERE id = p_contractor_id
      AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for contractor %', p_contractor_id;
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ip := COALESCE(
    split_part(v_headers->>'x-forwarded-for', ',', 1),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  UPDATE contractors
  SET ic_24511_attestation = COALESCE(ic_24511_attestation, '{}'::jsonb)
    || jsonb_build_object(
         'accepted_ip',   v_ip,
         'accepted_ua',   v_ua,
         'accepted_at',   NOW()
       ),
      attestation_accepted_at = COALESCE(attestation_accepted_at, NOW())
  WHERE id = p_contractor_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_attestation_ip(uuid) TO authenticated;

-- ── 5. RLS: quotes INSERT requires contractor_can_bid ───────
-- Replaces the prior INSERT policy if any. The existing SELECT
-- and UPDATE policies are NOT touched so historical bid reads
-- keep working even if COI subsequently expires.

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Contractors can insert quotes" ON quotes;

CREATE POLICY "Contractors can insert quotes" ON quotes
  FOR INSERT TO authenticated
  WITH CHECK (
    contractor_id IN (
      SELECT id FROM contractors WHERE user_id = auth.uid()
    )
    AND contractor_can_bid(contractor_id)
  );

-- ── 6. Verification ─────────────────────────────────────────
-- Run as an authenticated contractor missing a COI to confirm
-- the INSERT is rejected:
--
--   SET LOCAL ROLE authenticated;
--   SET LOCAL "request.jwt.claims" = '{"sub": "<user-id>", "role": "authenticated"}';
--   INSERT INTO quotes (claim_id, contractor_id, total_amount)
--   VALUES ('<claim-id>', '<contractor-id>', 10000);
--   Expected: ERROR — new row violates row-level security policy for table "quotes"
--
-- After uploading a valid COI and signing the attestation, the
-- same insert should succeed.
