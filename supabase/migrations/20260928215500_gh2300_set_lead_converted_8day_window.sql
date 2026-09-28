-- Migration: 20260928215500_gh2300_set_lead_converted_8day_window
-- GitHub: #2300 (finding: comment 5878649711), #2121 (HO-1.S16 / HO-2.S16)
-- Tier: 3B (recreates a live SECURITY DEFINER function). NOT APPLIED. Do not apply, merge or deploy without R-097 notice.
-- Rollback: supabase/migrations_rollbacks/20260928215500_gh2300_set_lead_converted_8day_window_rollback.sql
-- Pre-flight: supabase/migrations/20260928215500_gh2300_set_lead_converted_8day_window_pre-flight.md
-- Proof: supabase/tests/gh2300_set_lead_converted_window_proof.sql (BEGIN ... ROLLBACK only)
--
-- Summary: widen set_lead_converted's link window from 24 hours to 8 days.
--
-- WHY: send-lead-next-step-reminder only emails a lead once it is at least 24 h old
-- (REMINDER_MIN_AGE_MS) and up to 7 days old (REMINDER_MAX_AGE_MS). With a 24 h link
-- window, a homeowner who clicks the reminder and signs up is never linked
-- (the RPC returns false with HTTP 200, converted_user_id stays NULL) and
-- lead_goal_events undercounts conversion. 8 days = the reminder's 7-day maximum + 1.
--
-- WHAT IS UNCHANGED (verified by diffing against pg_get_functiondef on live production,
-- project yeszghaspzwwstvsrioa, 2026-09-28): the null-id check, the S1 anon rejection
-- (ERRCODE 28000), the D4 JWT-email ownership guard, first-write-wins
-- (converted_user_id IS NULL), SECURITY DEFINER, SET search_path = public, pg_temp,
-- and the ACL (privileges are not touched: CREATE OR REPLACE keeps the existing ACL). The ONLY changed executable token is: interval '24 hours' -> interval '8 days'.
-- The function COMMENT is updated so it no longer says "24h window".
--
-- Idempotent (CREATE OR REPLACE / COMMENT).

BEGIN;

CREATE OR REPLACE FUNCTION public.set_lead_converted(
  p_lead_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows int;
  v_uid uuid;
BEGIN
  IF p_lead_id IS NULL THEN
    RAISE EXCEPTION 'set_lead_converted: lead id required';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- S1 (PR #2163): reject an anon caller outright -- no anonymous write
    -- of this column is ever valid, whatever p_lead_id claims to be.
    RAISE EXCEPTION 'set_lead_converted: authentication required' USING ERRCODE = '28000';
  END IF;

  -- D4 fix: the caller's own JWT email must match the lead's email (case-
  -- insensitive) when the lead has one on file. leads.email is NOT NULL on
  -- every Arm F row, so this is not a no-op guard in practice -- it closes
  -- the "edit ?lead= to someone else's uuid" hijack the reviewer described,
  -- without requiring #2226's token model to land first.
  UPDATE public.leads
     SET converted_user_id = v_uid
   WHERE id = p_lead_id
     AND created_at > now() - interval '8 days'
     AND converted_user_id IS NULL
     AND (email IS NULL OR lower(email) = lower(auth.jwt() ->> 'email'));

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

COMMENT ON FUNCTION public.set_lead_converted(uuid) IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-26 (REVIEW: FAIL 5849942876, D4): SECURITY DEFINER write-back of leads.converted_user_id for auth.uid(), now ALSO requiring the caller''s JWT email to match the lead''s email (case-insensitive) when the lead has one -- closes the raw-uuid hijack (a signed-in visitor editing ?lead= to someone else''s fresh lead id). Stopgap ahead of PR #2226''s hashed lead_token model. First write wins; 8-day window (gh-2300: reminder max age 7 days + 1); anon rejected outright.';

COMMIT;
