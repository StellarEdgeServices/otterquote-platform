-- STATUS (gh-1438, as of 2026-10-13T20:39:04Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2491_claims_platform_fee_charged_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: production read-only 2026-10-13T20:02Z (Supabase MCP, CLOSE-REVIEW 6154236621 on #2491): no trigger on public.claims mentions platform_fee_charged, and has_column_privilege('authenticated','public.claims','platform_fee_charged','UPDATE') is true; rolled-back proof in supabase/tests/gh2491_platform_fee_charged_guard_proof.sql
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2491 precondition: a signed-in user cannot write claims.platform_fee_charged.
-- Tier: 3B (new trigger on a money-path table). Protective only (R-134): it only removes capability from
-- client roles. NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/gh2491_claims_platform_fee_charged_guard_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh2491_claims_platform_fee_charged_guard_pre-flight.md
-- Proof (throwaway Postgres, forward and rollback in one run): supabase/tests/gh2491_platform_fee_charged_guard_proof.sql
--
-- Why. Ben's condition on applying gh2491_message_counterpart.sql (#2491 comments 6023472925, 6029407730):
-- that function releases the homeowner's name to the selected contractor when claims.platform_fee_charged is
-- true, and the flag can be written from the browser today. The "Users can update own claims" policy has no
-- column restriction and `authenticated` holds UPDATE on every column of claims, so a claim owner can set the
-- flag true on their own claim (and INSERT a claim with it already true). The legitimate writers are the
-- docusign-webhook and stripe-webhook Edge Functions, which use the service-role client; no SQL function in the
-- live public schema writes the column (pg_proc scan, 2026-10-13: 0 functions mention platform_fee_charged).
--
-- Change. One new SECURITY INVOKER trigger function, claims_guard_platform_fee_charged(), and one trigger,
-- claims_guard_platform_fee_charged, BEFORE INSERT OR UPDATE OF platform_fee_charged ON public.claims.
-- For client callers (the same test the live claims guards use: current_user is anon or authenticated, the JWT
-- role is not service_role, the caller is not an admin):
--   - INSERT with platform_fee_charged = true is refused 42501 (false, NULL or omitted is fine);
--   - UPDATE that changes platform_fee_charged (either direction) is refused 42501. A value re-sent unchanged
--     is not a change, so a client save whose payload carries the stored value still lands.
-- service_role (every Edge Function), admins and owner-level (SECURITY DEFINER, postgres-owned) sessions are
-- untouched. SECURITY INVOKER on purpose: current_user must be the caller.
--
-- Not changed: the existing claims triggers and guard functions (claims_guard_referral_columns,
-- claims_payment_method_guard, ...), any policy, any grant, any data, get_message_counterpart (not touched here;
-- it stays in supabase/migrations_drafts/gh2491_message_counterpart.sql).
-- Not covered (named so nobody reads this as wider than it is): claims.platform_fee_amount and
-- claims.platform_fee_stripe_id are also client-writable today; they are not read by get_message_counterpart.
-- See the PR body (question 1).
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or REVOKE.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_guard_platform_fee_charged()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.platform_fee_charged IS TRUE THEN
        RAISE EXCEPTION 'claims: platform_fee_charged can only be set by service_role or an admin (gh-2491)'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.platform_fee_charged IS DISTINCT FROM OLD.platform_fee_charged THEN
      RAISE EXCEPTION 'claims: platform_fee_charged can only be changed by service_role or an admin (gh-2491)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_platform_fee_charged() IS
  'gh-2491: BEFORE INSERT OR UPDATE OF platform_fee_charged guard on public.claims. Client roles (anon, authenticated) that are not admins cannot create a claim with platform_fee_charged true and cannot change it on UPDATE (42501); an unchanged value is not a change. service_role (the payment webhooks), admins and owner-level sessions are untouched.';

DROP TRIGGER IF EXISTS claims_guard_platform_fee_charged ON public.claims;
CREATE TRIGGER claims_guard_platform_fee_charged
  BEFORE INSERT OR UPDATE OF platform_fee_charged ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_guard_platform_fee_charged();

COMMIT;
