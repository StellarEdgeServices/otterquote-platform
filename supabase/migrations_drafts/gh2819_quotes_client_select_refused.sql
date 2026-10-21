-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: forward file of set gh2819_quotes_client_select_refused (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-19 under #2819 (Marty ruling 6272462274, option 1; tier:3b-approved 6272917213 on Dustin's early-GO 6269637351). The #2620 proof (supabase/tests/gh2620_claims_payment_guard_proof.sql) printed AFTER-5b "rows=1 ACCEPTED" on production on 2026-10-15. No database was touched to write this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2819_quotes_client_select_refused
-- GitHub: #2819. Tier: 3B (money-path trigger). Apply order: the React fix (paired issue: awardClaimToContractor must call
--   supabase.rpc('accept_bid', ...)) is merged and deployed FIRST, then this file. Marty reviews, applies and verifies.
-- Rollback: supabase/migrations_drafts/gh2819_quotes_client_select_refused_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2819_quotes_client_select_refused_pre-flight.md
-- Proof: supabase/tests/gh2819_quotes_client_select_refused_proof.sql
--
-- The defect. A homeowner session can UPDATE quotes SET status = 'selected' directly (the policy "Homeowners can update quotes
-- for their claims" and quotes_guard_homeowner_columns() both admit status selected/declined for the claim owner). The claim then
-- stays 'bidding' while a bid reads as chosen. The award path is accept_bid(), which is SECURITY DEFINER.
--
-- The fix, and why it is a SEPARATE trigger and not an edit of quotes_guard_homeowner_columns(). That function is the shared
-- surface of gh2564 (applied, ledger 20261018195342, supabase/migrations/20261018195342_gh2564_quotes_selected_price_lock.sql,
-- sha256 7db30c31) and of open PR #2863 (gh-2803, notes freeze). This file
-- does NOT re-create it, so it does not need to be composed with either: the guard body on production stays byte-for-byte what it
-- is, and #2863 can apply before or after this file unchanged. Trigger order does not matter: this trigger only ever raises.
--
-- The rule. For client callers only (current_user anon/authenticated, JWT role not service_role, not an admin -- the same
-- condition the guard uses), an UPDATE that moves a quote INTO status 'selected' (OLD.status is not already 'selected') is refused
-- 42501. Nothing else is touched: declining a bid, the bid contractor's own edits, re-sending an already-selected row, and every
-- other column are decided by the existing guard exactly as before. Callers that still can write 'selected':
-- service_role (every Edge Function), admins, and owner-level SECURITY DEFINER functions (accept_bid() runs as the function owner,
-- so current_user is not anon/authenticated and the trigger never refuses it).
-- INSERT is not covered here: the guard already refuses any client-created quote that is not born 'submitted' (gh-2479).
-- Existing selected rows are not touched (the trigger acts only on a transition into selected). No data change.
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER.

BEGIN;

-- Apply gate: this file must never apply unless accept_bid() runs as its owner. If it were SECURITY INVOKER the trigger below
-- would refuse the award itself and no homeowner could pick a contractor.
DO $gate$
BEGIN
  IF to_regprocedure('public.accept_bid(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh2819: public.accept_bid(uuid, uuid) does not exist; refusing to apply';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'gh2819: accept_bid() is not SECURITY DEFINER; this trigger would refuse the award path itself';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2819: public.is_admin_email() does not exist; refusing to apply';
  END IF;
END
$gate$;

CREATE OR REPLACE FUNCTION public.quotes_refuse_client_select_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND NEW.status = 'selected'
     AND OLD.status IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'quotes: a bid can only be marked selected by accept_bid(); a direct status write is refused (gh-2819)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.quotes_refuse_client_select_status() IS
  'gh-2819: BEFORE UPDATE trigger function on public.quotes. Refuses (42501) a client caller (anon/authenticated, not service_role, not an admin) moving a quote into status selected; only accept_bid() (SECURITY DEFINER), service_role and admins can. Separate from quotes_guard_homeowner_columns() on purpose (no composition with gh2564 / #2863).';

-- A trigger function is not called by clients; no client role needs EXECUTE on it.
REVOKE EXECUTE ON FUNCTION public.quotes_refuse_client_select_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_refuse_client_select_status ON public.quotes;

CREATE TRIGGER quotes_refuse_client_select_status
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  WHEN (NEW.status = 'selected' AND OLD.status IS DISTINCT FROM 'selected')
  EXECUTE FUNCTION public.quotes_refuse_client_select_status();

COMMIT;
