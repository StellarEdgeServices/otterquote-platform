-- STATUS (gh-1438, as of 2026-10-06T21:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: payment_failures.retry_requested_at and public.request_dunning_retry(uuid) absent on production, read-only SELECT 2026-10-06 (gh-2442 build); anon holds UPDATE, TRUNCATE and TRIGGER on public.payment_failures on production, same query
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_request
-- GitHub: #2442 ([MONEY] the contractor "Retry Payment Now" button has never worked). Ruling: option A, comment 6025103626.
-- Tier: 3B (money-path table; adds a SECURITY DEFINER function and a REVOKE). NOT APPLIED by the authoring session or by CI.
-- Rollback: supabase/migrations_drafts/gh2442_dunning_retry_request_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2442_dunning_retry_request_pre-flight.md
-- Proof (rolled back, is_test rows only): supabase/tests/gh2442_dunning_retry_request_proof.sql
--
-- What it does.
--   1. Adds payment_failures.retry_requested_at (timestamptz, nullable, no default). Nothing reads it yet except
--      the function below; a retry pass in process-dunning (a separate, later change) will.
--   2. Adds request_dunning_retry(p_failure_id uuid) -> jsonb. SECURITY DEFINER, search_path pinned, no dynamic SQL.
--      The signed-in caller must own the failure through contractors.user_id = auth.uid(); anyone else (another
--      contractor, a homeowner, an unknown id) gets 42501 with the same message, so the function is not an oracle for
--      which ids exist. The failure must be dunning_status active or warning_sent and not resolved. The ONLY column it
--      writes is retry_requested_at. A second call within 15 minutes of the stored request writes nothing and returns the
--      existing request. Returns {"status": requested | already_requested | not_retryable, "retry_requested_at": ts|null}.
--   3. Grants EXECUTE to authenticated only (revoked from PUBLIC and anon). This is a NEW GRANT to `authenticated`:
--      when this file is filed under supabase/migrations/ the "No new GRANT to anon/PUBLIC/authenticated" check
--      (permissions-ratchet) needs the PR label `permissions-ratchet: reviewed`.
--   4. Revokes anon UPDATE, TRUNCATE and TRIGGER on payment_failures. RLS already blocked anon rows; the grants were
--      only a missing second lock. anon SELECT and REFERENCES are left as they are (no anon policy exists, so SELECT
--      returns nothing); they are not writes. authenticated's own table grants are NOT changed here (see pre-flight).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, GRANT/REVOKE.

BEGIN;

ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;

COMMENT ON COLUMN public.payment_failures.retry_requested_at IS
  'gh-2442: when the contractor last asked for a payment retry via request_dunning_retry(). Set by that function only.';

CREATE OR REPLACE FUNCTION public.request_dunning_retry(p_failure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_row record;
BEGIN
  IF v_uid IS NULL OR p_failure_id IS NULL THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- Ownership: the failure's contractor must be the caller's own contractor row. The row lock serialises two
  -- clicks, so the second one sees the first one's request.
  SELECT pf.dunning_status, pf.resolved_at, pf.retry_requested_at
    INTO v_row
    FROM public.payment_failures pf
    JOIN public.contractors k ON k.id = pf.contractor_id
   WHERE pf.id = p_failure_id
     AND k.user_id = v_uid
     FOR UPDATE OF pf;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  IF v_row.dunning_status IS NULL
     OR v_row.dunning_status NOT IN ('active', 'warning_sent')
     OR v_row.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'retry_requested_at', v_row.retry_requested_at);
  END IF;

  IF v_row.retry_requested_at IS NOT NULL
     AND v_row.retry_requested_at > v_now - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'already_requested', 'retry_requested_at', v_row.retry_requested_at);
  END IF;

  UPDATE public.payment_failures
     SET retry_requested_at = v_now
   WHERE id = p_failure_id;

  RETURN jsonb_build_object('status', 'requested', 'retry_requested_at', v_now);
END
$fn$;

REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;

REVOKE UPDATE, TRUNCATE, TRIGGER ON public.payment_failures FROM anon;

COMMIT;
