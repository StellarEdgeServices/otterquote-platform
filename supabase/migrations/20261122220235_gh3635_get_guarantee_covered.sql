-- gh-3635 (P23): get_guarantee_covered(p_claim_id) -- the covered-state answer BEFORE the homeowner pays.
-- STATUS (gh-1438, as of 2026-11-19): NOT APPLIED
-- EVIDENCE: written from the repo (create-measurement-order/guarantee-coverage.ts, gh3471_guarantee_covered.sql, gh-2421 get_homeowner_blocked_states). Executed only in a throwaway PGlite
--   (stub auth.uid / claims / platform_settings) against the TS rules: 286 list-x-state cases, 0 mismatches; see guarantee-covered-sql-parity.test.ts. No production read or write was made.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3A path (REVIEW, LEGAL-READ, R-177, a recorded apply); once applied, copy to supabase/migrations/ under the ledger version.
-- WHY: hover_orders.guarantee_covered (gh-3471) is written in the same INSERT as the paid order, so a first-time buyer has no row before paying, and the
--   excluded-state list (platform_settings key guarantee_excluded_states) is service-role-only. The purchase-step page needs one boolean, for its own claim, without
--   reading the list. This function is that boolean. Pattern copied from get_homeowner_blocked_states() (gh-2421, D-344): purely additive, SECURITY DEFINER read of
--   platform_settings, RLS allow-list policy NOT touched (that would be a 3B policy rewrite and would expose the list).
-- RULE (unchanged, Dustin #3427 D6 / #3471): covered unless the claim's state is on the excluded list. Same rules as supabase/functions/create-measurement-order/guarantee-coverage.ts:
--   list: no row / not a JSON array / ANY element not a string of two letters A-Z after btrim (spaces) + upper()  -> NULL (unknown); NO fallback list; [] = nothing excluded.
--   state: claims.property_state trimmed (whitespace) + upper-cased must be exactly two letters A-Z, else NULL. Never guessed.
--   true = state not on the list; false = on the list; NULL = unknown OR the claim is not the caller's (no information leaks about other people's claims).
-- ACCESS: returns NULL unless the claim belongs to auth.uid(). EXECUTE granted to authenticated only; revoked from PUBLIC and anon.
-- Parity with the TypeScript copy is proved by supabase/functions/create-measurement-order/guarantee-covered-sql-parity.test.ts.
-- Rollback: supabase/migrations_rollbacks/gh3635_get_guarantee_covered_rollback.sql
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_guarantee_covered(p_claim_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid   uuid;
  v_owner uuid;
  v_state text;
  v_val   jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_claim_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only the claim's own buyer gets an answer.
  SELECT c.user_id, c.property_state INTO v_owner, v_state
    FROM public.claims c
   WHERE c.id = p_claim_id;
  IF NOT FOUND OR v_owner IS DISTINCT FROM v_uid THEN
    RETURN NULL;
  END IF;

  -- The excluded-state list. No row, JSON null or not an array: unknown. No fallback list.
  SELECT s.value INTO v_val
    FROM public.platform_settings s
   WHERE s.key = 'guarantee_excluded_states';
  IF v_val IS NULL OR jsonb_typeof(v_val) <> 'array' THEN
    RETURN NULL;
  END IF;

  -- Any element that is not a string holding a two-letter code makes the WHOLE list unusable (a typo must not cover a state).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_val) AS t(e)
     WHERE jsonb_typeof(e) <> 'string'
        OR upper(btrim(e #>> '{}')) !~ '^[A-Z]{2}$'
  ) THEN
    RETURN NULL;
  END IF;

  -- The claim's state: trimmed, upper-cased, exactly two letters A-Z, else unknown.
  -- Whitespace set = JavaScript String.prototype.trim() (what normalizePropertyState uses), so the two copies agree.
  v_state := upper(regexp_replace(v_state,
    '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'));
  IF v_state IS NULL OR v_state !~ '^[A-Z]{2}$' THEN
    RETURN NULL;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(v_val) AS t(e)
     WHERE upper(btrim(e)) = v_state
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_guarantee_covered(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_guarantee_covered(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_guarantee_covered(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_guarantee_covered(uuid) IS
  'gh-3635 / #3471: whether the caller''s own claim is in a covered state for the 100-hour guarantee (true = not on platform_settings guarantee_excluded_states, false = excluded, NULL = unknown or not the caller''s claim). Reads the service-role-only list; returns only the boolean.';

COMMIT;
