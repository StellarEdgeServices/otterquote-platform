-- ============================================================================
-- v97 — Partner account claim RPC  (GitHub #594)
-- ============================================================================
--
-- PROBLEM
--   referral_agents rows are created by register_partner() with user_id NULL
--   (by design — the partner is not authenticated yet at signup time). The
--   linkage to auth.users was supposed to happen client-side after the magic
--   link is clicked, authorised by this RLS policy:
--
--     "Authenticated can claim unclaimed partner record"  (UPDATE)
--       USING      (user_id IS NULL AND email = auth.jwt() ->> 'email')
--       WITH CHECK (user_id = auth.uid())
--
--   That policy is UNREACHABLE. PostgreSQL applies SELECT policies to an
--   UPDATE whose WHERE clause reads table columns, and referral_agents has no
--   SELECT policy exposing a row with user_id IS NULL to a non-admin
--   authenticated user:
--
--     "Agents can manage own profile"     ALL     user_id = auth.uid()      -> false
--     "Admin can read all referral agents" SELECT is_admin_email()          -> false
--     "Partners can read their recruits"   SELECT recruited_by_id = ...     -> false
--
--   So the claim UPDATE matches 0 rows and returns NO error. Every partner is
--   locked out of partner-dashboard.html, on every device. Same silent
--   failure class as #571 (client write-then-read with no SELECT policy).
--
--   Verified against production in a rolled-back transaction, simulating a
--   real partner session (SET LOCAL ROLE authenticated + real JWT claims):
--     SELECT ... WHERE email = <own> AND user_id IS NULL   -> 0 rows
--     UPDATE ... WHERE email = <own> AND user_id IS NULL   -> 0 rows, no error
--
-- SOLUTION
--   A SECURITY DEFINER RPC, matching the v95 architecture (register_partner,
--   track_referral_click, advance_referral_registered). Identity and email are
--   both derived from the JWT — there are NO client-supplied parameters, so a
--   caller can only ever claim a row matching their own verified email. The
--   unreachable RLS policy is left in place as defence in depth.
--
-- TIER: 3A (additive — new function only; no schema change, no RLS change,
--       nothing destructive). Autonomous per D-182 as amended by D-261.
--
-- GRANTS: migration-author Danger Pattern #9 — Supabase default privileges
--   grant anon EXECUTE on new functions unless explicitly revoked (the v95a
--   near-miss). Explicit per-role REVOKE + GRANT below, with a negative probe.
--
-- Rollback: sql/v97-rollback-partner-account-claim.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_partner_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(COALESCE(auth.jwt() ->> 'email', '')));
  v_row   public.referral_agents%ROWTYPE;
BEGIN
  -- Anonymous / malformed session: nothing to claim. Never raise — the caller
  -- is a page-load path and must not be broken by an unauthenticated hit.
  IF v_uid IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_authenticated');
  END IF;

  -- Idempotency: already linked (including a re-run on the same page load).
  SELECT * INTO v_row
    FROM public.referral_agents
   WHERE user_id = v_uid;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'claimed',     false,
      'reason',      'already_linked',
      'agent_id',    v_row.id,
      'unique_code', v_row.unique_code
    );
  END IF;

  -- Claim the unclaimed row whose email matches this JWT's verified email.
  -- lower() on both sides: register_partner stores lower(btrim(email)), but
  -- legacy rows (pre-v95, client-inserted) may carry mixed case.
  UPDATE public.referral_agents
     SET user_id = v_uid
   WHERE lower(email) = v_email
     AND user_id IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_unclaimed_partner');
  END IF;

  RETURN jsonb_build_object(
    'claimed',     true,
    'agent_id',    v_row.id,
    'unique_code', v_row.unique_code
  );

EXCEPTION
  -- A claim failure must never break the dashboard page load.
  WHEN OTHERS THEN
    RAISE LOG 'claim_partner_account failed for uid=% sqlstate=% sqlerrm=%',
      v_uid, SQLSTATE, SQLERRM;
    RETURN jsonb_build_object('claimed', false, 'reason', 'error');
END;
$function$;

COMMENT ON FUNCTION public.claim_partner_account() IS
'D-172/#594: links referral_agents.user_id to the calling auth user. Both identity and email come from the JWT — no client-supplied parameters — so a caller can only claim a row matching their own verified email. Idempotent. SECURITY DEFINER because the "Authenticated can claim unclaimed partner record" RLS policy is unreachable (UPDATE...WHERE requires SELECT visibility that no policy grants for user_id IS NULL rows). authenticated EXECUTE only; anon explicitly revoked per Danger Pattern #9.';

-- ── Grants (Danger Pattern #9) ───────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.claim_partner_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_partner_account() FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_account() TO authenticated;

-- ── Negative probe — fail the migration if anon can execute ──────────────────
DO $probe$
BEGIN
  IF has_function_privilege('anon', 'public.claim_partner_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v97 SAFETY: anon has EXECUTE on claim_partner_account() — aborting';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.claim_partner_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v97 SAFETY: authenticated lacks EXECUTE on claim_partner_account() — aborting';
  END IF;
END
$probe$;

-- ── Backfill: rows the application could never link ──────────────────────────
-- Every referral_agents row with user_id IS NULL that has a matching
-- auth.users account. Safe: exact email match, one-to-one, never overwrites a
-- row that is already linked.
UPDATE public.referral_agents ra
   SET user_id = u.id
  FROM auth.users u
 WHERE ra.user_id IS NULL
   AND lower(ra.email) = lower(u.email);

COMMIT;
