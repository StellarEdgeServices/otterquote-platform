-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: forward file of set gh2864_quotes_signature_stamps_platform_only (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-19 under #2864 (Marty ruling 6274566683, tier:3b notice; window closes 2026-10-20T18:40:35Z). The live guard quotes_guard_homeowner_columns() admits homeowner_signed_at for the claim owner and contractor_signed_at for the bid contractor (read-only pg_get_functiondef, 2026-10-19). Probe N17 on PR #2863 (contractor clears its own contractor_signed_at, ACCEPTED rows=1) is the contractor half. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2864_quotes_signature_stamps_platform_only
-- GitHub: #2864. Tier: 3B (trigger on the quotes money/contract path). Apply order: after #2913 (gh2819_quotes_client_select_refused)
--   and the #2863 (gh-2803) notes-freeze trigger, the same quotes guard surface (gh2564 order). Because this file is a separate trigger it
--   composes with them in any order; the order is kept for review and proof readability. Marty reviews, applies and verifies.
-- Rollback: supabase/migrations_drafts/gh2864_quotes_signature_stamps_platform_only_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2864_quotes_signature_stamps_platform_only_pre-flight.md
-- Proof: supabase/tests/gh2864_quotes_signature_stamps_platform_only_proof.sql
--
-- The defect. The shared guard quotes_guard_homeowner_columns() puts homeowner_signed_at on the claim owner's column allow-list and
-- contractor_signed_at on the bid contractor's, so a browser session can UPDATE either stamp, including back to NULL. Clearing a stamp
-- reopens every rule keyed on it: the D-381 notes freeze (#2844, #2863, either signature per #2846) and anything that treats the bid
-- as signed. The only writers in the repo are service_role Edge Functions: docusign-webhook (sets both stamps; supabase/functions/
-- docusign-webhook/index.ts) and admin-reissue-contract (clears both on a re-issue, service_role). No page or react-app code writes
-- either stamp (grep, 2026-10-19). Blast radius today: 0 real signed quotes.
--
-- The fix, and why it is a SEPARATE trigger and not an edit of quotes_guard_homeowner_columns(). That function is the shared surface of
-- gh2564 (applied, ledger 20261018195342), PR #2863 (gh-2803) and, by the same pattern, PR #2913 (gh-2819). This file does NOT re-create
-- it: the guard body on production stays byte-for-byte what it is. Trigger order does not matter: this trigger only ever raises
-- (it never changes NEW), and Postgres fires BEFORE triggers by name, so quotes_refuse_client_signature_change sorts after
-- quotes_guard_homeowner_columns and quotes_normalize_fee_amount and before set_updated_at_quotes.
--
-- The rule. For client callers only (current_user anon/authenticated, JWT role not service_role, not an admin -- the same condition the
-- guard and #2913 use), an UPDATE that CHANGES either homeowner_signed_at or contractor_signed_at is refused 42501: clearing it to NULL, overwriting it, and
-- setting a NULL stamp to a value (forging a first signature, Marty CTO RUN 72 extension) alike. Callers that still write the stamps: service_role (docusign-webhook, admin-reissue-contract), admins, and owner-level
-- SECURITY DEFINER functions (current_user is then the function owner, not anon/authenticated, so the trigger never refuses them).
-- NOT covered: a value re-sent unchanged (not a change). INSERT is not covered: the guard already refuses any client-created quote
-- carrying either stamp (gh-2479). No data change.
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER.

BEGIN;

-- Apply gate: the admin test and both columns must exist, or the trigger would fail every client UPDATE on quotes.
DO $gate$
BEGIN
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2864: public.is_admin_email() does not exist; refusing to apply';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quotes'
         AND column_name IN ('homeowner_signed_at', 'contractor_signed_at')) <> 2 THEN
    RAISE EXCEPTION 'gh2864: quotes.homeowner_signed_at / contractor_signed_at not both present; refusing to apply';
  END IF;
END
$gate$;

CREATE OR REPLACE FUNCTION public.quotes_refuse_client_signature_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND (NEW.homeowner_signed_at IS DISTINCT FROM OLD.homeowner_signed_at
          OR NEW.contractor_signed_at IS DISTINCT FROM OLD.contractor_signed_at) THEN
    RAISE EXCEPTION 'quotes: a signature stamp (homeowner_signed_at / contractor_signed_at) can only be written by the platform; a direct write is refused (gh-2864)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.quotes_refuse_client_signature_change() IS
  'gh-2864: BEFORE UPDATE trigger function on public.quotes. Refuses (42501) a client caller (anon/authenticated, not service_role, not an admin) changing homeowner_signed_at or contractor_signed_at in any way (clear, overwrite, or first stamp); service_role (docusign-webhook, admin-reissue-contract), admins and SECURITY DEFINER functions pass. Separate from quotes_guard_homeowner_columns() on purpose (no composition with gh2564 / #2863 / #2913).';

-- A trigger function is not called by clients; no client role needs EXECUTE on it.
REVOKE EXECUTE ON FUNCTION public.quotes_refuse_client_signature_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_refuse_client_signature_change ON public.quotes;

CREATE TRIGGER quotes_refuse_client_signature_change
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  WHEN (NEW.homeowner_signed_at IS DISTINCT FROM OLD.homeowner_signed_at
        OR NEW.contractor_signed_at IS DISTINCT FROM OLD.contractor_signed_at)
  EXECUTE FUNCTION public.quotes_refuse_client_signature_change();

COMMIT;
