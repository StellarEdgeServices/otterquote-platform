-- Migration: v97_partner_account_claim
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-02T16:44:12Z, recorded in
-- supabase_migrations.schema_migrations as version 20260802164412, name
-- "v97_partner_account_claim". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

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
  IF v_uid IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_authenticated');
  END IF;

  SELECT * INTO v_row FROM public.referral_agents WHERE user_id = v_uid;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_linked',
                              'agent_id', v_row.id, 'unique_code', v_row.unique_code);
  END IF;

  UPDATE public.referral_agents
     SET user_id = v_uid
   WHERE lower(email) = v_email
     AND user_id IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_unclaimed_partner');
  END IF;

  RETURN jsonb_build_object('claimed', true, 'agent_id', v_row.id,
                            'unique_code', v_row.unique_code);
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'claim_partner_account failed for uid=% sqlstate=% sqlerrm=%',
      v_uid, SQLSTATE, SQLERRM;
    RETURN jsonb_build_object('claimed', false, 'reason', 'error');
END;
$function$;

COMMENT ON FUNCTION public.claim_partner_account() IS
'D-172/#594: links referral_agents.user_id to the calling auth user. Both identity and email come from the JWT - no client-supplied parameters - so a caller can only claim a row matching their own verified email. Idempotent. SECURITY DEFINER because the "Authenticated can claim unclaimed partner record" RLS policy is unreachable (UPDATE...WHERE requires SELECT visibility that no policy grants for user_id IS NULL rows). authenticated EXECUTE only; anon explicitly revoked per Danger Pattern #9.';

REVOKE ALL ON FUNCTION public.claim_partner_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_partner_account() FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_account() TO authenticated;

DO $probe$
BEGIN
  IF has_function_privilege('anon', 'public.claim_partner_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v97 SAFETY: anon has EXECUTE on claim_partner_account() - aborting';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.claim_partner_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'v97 SAFETY: authenticated lacks EXECUTE on claim_partner_account() - aborting';
  END IF;
END
$probe$;

UPDATE public.referral_agents ra
   SET user_id = u.id
  FROM auth.users u
 WHERE ra.user_id IS NULL
   AND lower(ra.email) = lower(u.email);
