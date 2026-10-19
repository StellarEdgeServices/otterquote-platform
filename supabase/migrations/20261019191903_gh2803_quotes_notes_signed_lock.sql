-- gh-2803 (D-381; PR #2844 review finding 1): once EITHER party has signed, no client caller can change quotes.notes.
-- BOUND per Dustin's ruling on #2846 (2026-10-18T22:11:53Z, option (b) "At contractor signature"): homeowner_signed_at IS NOT NULL OR contractor_signed_at IS NOT NULL.
-- STATUS (gh-1438): NOT APPLIED
-- EVIDENCE: independent review 6254508202 on PR #2844 reproduced, with the gh2564 price lock live, a direct table write of quotes.notes on a signed bid
--   (probe ACCEPTED, rows=1). notes print into the signed contract PDF ("Message from Contractor"), so a contractor could rewrite signed contract text.
--   Before/after proof: supabase/tests/gh2803_notes_signed_lock_proof.sql, run by supabase/tests/gh2803_notes_signed_lock_proof_run.sh.
-- REPO COPY: none in supabase/migrations/ (not applied). Rollback: supabase/migrations_drafts/gh2803_quotes_notes_signed_lock_rollback.sql
--   Pre-flight: supabase/migrations_drafts/gh2803_quotes_notes_signed_lock_pre-flight.md
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177 if the gate is red, tier:3b-approved after the R-097 window ends
--   2026-10-19T18:37:39Z, recorded apply). Sequence: gh2626 -> gh2519 -> gh2564 -> gh2803 RPC (PR #2844) -> this file (any order after gh2564 is safe; see below).
--
-- DESIGN. A SEPARATE small BEFORE UPDATE OF notes trigger, NOT another clause in quotes_guard_homeowner_columns().
--   Why not the guard: that function is re-created (CREATE OR REPLACE, whole body) by gh2626, gh2519 and gh2564, and the gh2564 order is still open with #2819
--   on the same surface. A fourth full-body copy would silently revert whichever of those lands after it, and its own rollback would have to carry the whole
--   current body again. A separate function/trigger never reads or writes that body, so it cannot overwrite the live guard in either apply order, and its
--   rollback is a DROP TRIGGER + DROP FUNCTION that restores exactly the state before it.
-- BOUND (same as update_selected_bid_notes() in PR #2844): refuse once quotes.homeowner_signed_at OR quotes.contractor_signed_at is set (read from OLD, so one statement that clears a signature and edits notes is still refused).
-- PLAIN BEFORE UPDATE (not "OF notes"), adopting the reviewer's non-blocking suggestion: an OF-column trigger fires only when notes is in the statement's SET list, so an UPDATE of another column whose chained trigger rewrites NEW.notes would slip past. This trigger fires on every UPDATE and compares NEW.notes to OLD.notes, so it sees such a rewrite made by any trigger that fires BEFORE it (Postgres fires BEFORE triggers in name order; a trigger sorting after quotes_refuse_signed_notes_change would not be seen). Acts only for a client caller, with the guard's own
--   condition: current_user IN ('anon','authenticated') AND auth.role() <> 'service_role' AND NOT is_admin_email(). service_role, admins and owner-level
--   (SECURITY DEFINER) sessions such as update_selected_bid_notes() are untouched; that function refuses after signature on its own (22023).
--   An unchanged value is not a change. Refused with 42501, as every other guard refusal. Before signature, notes stay writable exactly as today.
-- No table, policy, grant or data change. Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS then CREATE TRIGGER.
-- NOT APPLIED by the authoring session. Tier 3B (R-097 notice, issue #2803 comment 2026-10-18T18:38:42Z).

BEGIN;

CREATE OR REPLACE FUNCTION public.quotes_refuse_signed_notes_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND (OLD.homeowner_signed_at IS NOT NULL OR OLD.contractor_signed_at IS NOT NULL)
     AND NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'quotes: notes cannot be changed once the contract has been signed by either party; they print in the contract (gh-2803)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS quotes_refuse_signed_notes_change ON public.quotes;
CREATE TRIGGER quotes_refuse_signed_notes_change
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_refuse_signed_notes_change();

COMMENT ON FUNCTION public.quotes_refuse_signed_notes_change() IS
  'gh-2803 (D-381): BEFORE UPDATE trigger on public.quotes. A client caller (anon/authenticated, not service_role, not an admin) cannot change notes once homeowner_signed_at or contractor_signed_at is set (42501); notes print in the signed contract PDF. Unchanged value is not a change. service_role, admins and SECURITY DEFINER sessions are untouched. Separate from quotes_guard_homeowner_columns() on purpose, so no guard body is re-created.';

COMMIT;
