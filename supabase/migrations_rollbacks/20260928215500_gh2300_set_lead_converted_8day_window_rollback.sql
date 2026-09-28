-- Rollback for: supabase/migrations/20260928215500_gh2300_set_lead_converted_8day_window.sql
-- GitHub: #2300, #2121
-- Tier 3B. Restores set_lead_converted(uuid) to its live pre-change definition (interval '24 hours'),
-- copied from 20260926221500_gh2121_s16_lead_goal_security_fix.sql and confirmed identical to
-- pg_get_functiondef on production (prosrc md5 ba14bac2d9871665b052106b25b42dfb) on 2026-09-28.
-- Effect of running it: reminded leads (24 h - 7 days old) stop linking again. Leads already linked stay linked
-- (this touches no data). Grants and the function signature are unchanged.

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
     AND created_at > now() - interval '24 hours'
     AND converted_user_id IS NULL
     AND (email IS NULL OR lower(email) = lower(auth.jwt() ->> 'email'));

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.set_lead_converted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_converted(uuid) TO authenticated;

COMMENT ON FUNCTION public.set_lead_converted(uuid) IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-26 (REVIEW: FAIL 5849942876, D4): SECURITY DEFINER write-back of leads.converted_user_id for auth.uid(), now ALSO requiring the caller''s JWT email to match the lead''s email (case-insensitive) when the lead has one -- closes the raw-uuid hijack (a signed-in visitor editing ?lead= to someone else''s fresh lead id). Stopgap ahead of PR #2226''s hashed lead_token model. First write wins; 24h window; anon rejected outright.';

COMMIT;
