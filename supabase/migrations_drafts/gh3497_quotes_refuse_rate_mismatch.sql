-- gh-3497 part 2: a client-written bid is refused when the fee rate it DISPLAYED differs from the configured rate.
-- STATUS (gh-1438): NOT APPLIED
-- EVIDENCE: LEGAL-READ 6675181967 on PR #3491 (issue #3497). quotes_guard_homeowner_columns() (gh-2519) overwrites platform_fee_pct on a client
--   INSERT with the configured rate, silently. A bid form that shows 5.00 while 7.50 is configured therefore records and discloses $1,250.00 on a
--   $25,000 bid and stores and charges $1,875.00, with no alert. Proof (throwaway Postgres 16, before and after, beside a rollback that returns to
--   the failing state): supabase/tests/gh3497_quotes_refuse_rate_mismatch_proof.sql, run by supabase/tests/gh3497_quotes_refuse_rate_mismatch_proof_run.sh.
-- REPO COPY: none in supabase/migrations/ (not applied). Rollback: supabase/migrations_drafts/gh3497_quotes_refuse_rate_mismatch_rollback.sql
--   Pre-flight: supabase/migrations_drafts/gh3497_quotes_refuse_rate_mismatch_pre-flight.md
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177, R-097 24-hour notice, recorded apply).
--
-- Tier 3B (a trigger on the live bid table that changes what a bid insert does).
--
-- DESIGN. A SEPARATE small BEFORE INSERT trigger, NOT another clause in quotes_guard_homeowner_columns(). Same reasoning as gh2803 (see
--   gh2803_quotes_notes_signed_lock.sql): the guard is re-created whole by gh2626, gh2519 and gh2564; one more full-body copy could silently revert
--   whichever of them lands after it. A separate function and trigger never read or write that body, and the rollback is a DROP.
-- WHAT IT REFUSES. A client caller (current_user IN ('anon','authenticated'), auth.role() <> 'service_role', not an admin; the guard's own condition)
--   INSERTs, for the contractor it names (anyone else is left to the guard's 42501), a quote whose platform_fee_pct (the "displayed rate": both bid forms send the rate on screen in that column) is NOT NULL and differs
--   from quotes_platform_fee_for(contractor_id, claim_id).fee_pct (the rate the guard is about to store and the webhook to charge). Refused with
--   SQLSTATE P0001 and a message that begins "quotes: fee_rate_mismatch:", carrying both rates. Equal rates pass, whatever their scale (5 = 5.00).
-- WHAT IT DOES NOT TOUCH (each is a test line in the proof):
--   - service_role (every Edge Function, including process-auto-bids, which sets the rate itself from the config table with the service key),
--     admins and owner-level SECURITY DEFINER sessions: the condition above is false, nothing is read, nothing is refused.
--   - A client insert that sends NO displayed rate (platform_fee_pct NULL): there is nothing displayed to contradict, so it is not refused; the guard
--     then stores the configured rate exactly as it does today. This is what keeps any path that inserts a quote without a displayed rate working.
--   - A client insert when NO config row applies: this trigger stays out of the way and the guard refuses it with its own message (P0001, gh-2519).
--   - UPDATE. The guard already keeps the stored rate on a contractor's UPDATE (c_revised_bid_takes_current_config_rate = false, CEO ruling 6050104316).
--   - The columns fee_percentage, fee_amount and platform_fee_basis. The forms do NOT send the displayed rate in fee_percentage: they send a
--     constant 5.0 (contractor-bid-form.html `const feePercentage = 5.0;`, React QUOTE_FEE_PERCENTAGE) and fee_amount = feeBase * (5.0 / 100),
--     unrounded. The guard overwrites fee_percentage, fee_amount and platform_fee_basis on a client INSERT (gh2519/gh2564), so this trigger
--     compares only platform_fee_pct and never reads those columns (REVIEW 6742716209 finding 5).
-- ORDER MATTERS. The guard overwrites NEW.platform_fee_pct, so this trigger must read it first. BEFORE ROW triggers fire in name order (C collation):
--   quotes_check_displayed_fee_rate sorts before quotes_enforce_bid_can_submit and quotes_guard_homeowner_columns. The DO block at the end of this
--   file raises (and rolls everything back) if that is not the order on the database it is applied to. The proof renames the trigger to sort AFTER the
--   guard and shows the hole open again (control).
-- SAME-STATEMENT SNAPSHOT. quotes_platform_fee_for() is STABLE; this trigger and the guard each call it inside the one INSERT statement, so both see the
--   same configured rate. The check and the stored value cannot disagree because of a config change between the two calls.
-- FAILURE MODE (what happens to the bid). The refusal is an exception in the INSERT, so nothing is stored: no quote row, and the bid forms insert
--   fee_acceptances only after the quote insert succeeds, so no acceptance row either. supabase-js returns it as `error`; both forms already throw on a
--   quote insert error, leave the contractor's entries in place, unlock the form and show the message ("Error submitting bid: ..."). With this PR the
--   forms also recognise fee_rate_mismatch, re-read the rate and show the configured figure with the acceptance cleared, so the contractor re-accepts and
--   resubmits. It is never a silent overwrite and never a lost bid.
-- ORDER OF ROLLOUT. Part 1 (both bid forms read the rate through quotes_platform_fee_for and stop with no answer) can ship first, last, or together.
--   Applied BEFORE part 1 is deployed, nothing changes at the one 5.00 rate; at any other rate the old forms (which show 5.00) are refused loudly, none
--   is silently charged a different rate. The CONDITION on #3497 (no insert into or fee_pct update on platform_fee_config) lifts only when BOTH are live.
--
-- No table, policy, grant or data change. Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS then CREATE TRIGGER.
-- NOT APPLIED by the authoring session.

BEGIN;

-- gh-2519 must be applied: this reads its function, and without the guard there is nothing server-side to compare against.
DO $gate$
BEGIN
  IF to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3497: public.quotes_platform_fee_for(uuid,uuid) does not exist; apply gh2519 first';
  END IF;
  IF COALESCE((SELECT position('gh-2519' IN prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.quotes_guard_homeowner_columns()')), 0) = 0 THEN
    RAISE EXCEPTION 'gh3497: quotes_guard_homeowner_columns() does not carry gh-2519; apply gh2519 first';
  END IF;
END
$gate$;

CREATE OR REPLACE FUNCTION public.quotes_check_displayed_fee_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_fee_pct numeric;
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND NEW.platform_fee_pct IS NOT NULL
     -- only the named contractor's own bid: anyone else gets the guard's 42501 (gh-2479) and is told no rate
     AND COALESCE(EXISTS (SELECT 1 FROM public.contractors k WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
    SELECT f.fee_pct INTO v_fee_pct FROM public.quotes_platform_fee_for(NEW.contractor_id, NEW.claim_id) f;
    -- no row: leave it to the guard, which refuses with its own message (gh-2519)
    IF v_fee_pct IS NOT NULL AND NEW.platform_fee_pct IS DISTINCT FROM v_fee_pct THEN
      RAISE EXCEPTION 'quotes: fee_rate_mismatch: the fee rate shown with this bid is % percent but the configured rate is % percent, so the bid was not saved (gh-3497)',
        trim(to_char(NEW.platform_fee_pct, 'FM990.00')), trim(to_char(v_fee_pct, 'FM990.00'))
        USING ERRCODE = 'P0001',
              DETAIL = format('displayed=%s configured=%s', NEW.platform_fee_pct, v_fee_pct),
              HINT = 'Read the rate with quotes_platform_fee_for(), show it, and have the contractor accept that figure again.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.quotes_check_displayed_fee_rate() IS
  'gh-3497: BEFORE INSERT trigger function on public.quotes. A client caller (anon/authenticated, not service_role, not an admin) that sends a platform_fee_pct different from quotes_platform_fee_for(contractor, claim) is refused (P0001, "fee_rate_mismatch"); no displayed rate (NULL), no config row, service_role and admins are untouched. Must fire before quotes_guard_homeowner_columns(), which overwrites the rate.';

DROP TRIGGER IF EXISTS quotes_check_displayed_fee_rate ON public.quotes;
CREATE TRIGGER quotes_check_displayed_fee_rate
  BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_check_displayed_fee_rate();

-- Order gate: this trigger must fire before the guard (name order, C collation) or the rate it reads is already overwritten.
DO $order$
DECLARE v_names text[];
BEGIN
  SELECT array_agg(t.tgname::text ORDER BY t.tgname::text COLLATE "C") INTO v_names
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4;   -- ROW, BEFORE, INSERT
  IF array_position(v_names, 'quotes_guard_homeowner_columns') IS NOT NULL
     AND array_position(v_names, 'quotes_check_displayed_fee_rate') > array_position(v_names, 'quotes_guard_homeowner_columns') THEN
    RAISE EXCEPTION 'gh3497: quotes_check_displayed_fee_rate would fire after quotes_guard_homeowner_columns (order: %); it would read an already-overwritten rate', v_names;
  END IF;
END
$order$;

COMMIT;
