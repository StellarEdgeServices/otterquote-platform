-- STATUS (gh-1438, as of 2026-10-14T06:58:34Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2710_claims_fee_stripe_columns_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: issue #2710 (CEO RUN 104 triage; R-177 SIGNED condition (4) on PR #2704, comment 6155920082); rolled-back proof in supabase/tests/gh2710_claims_fee_stripe_columns_guard_proof.sql
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2710 (MONEY PATH): a claim owner cannot write claims.platform_fee_stripe_id or claims.platform_fee_amount.
-- Tier: 3B (new trigger on a money-path table). Protective only (R-134): it only removes capability from client
-- roles. NOT APPLIED by the authoring session or by CI. R-097 notice applies. R177-NEEDED.
-- Rollback: supabase/migrations_rollbacks/gh2710_claims_fee_stripe_columns_guard_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh2710_claims_fee_stripe_columns_guard_pre-flight.md
-- Proof (throwaway Postgres): supabase/tests/gh2710_claims_fee_stripe_columns_guard_proof.sql, run by ..._proof_run.sh
--
-- Why. stripe-webhook routes a dispute to its claim by claims.platform_fee_stripe_id (index.ts L476), and the
-- dispute evidence reads platform_fee_amount. The policy "Users can update own claims" has no column restriction
-- and authenticated holds UPDATE on every column, so a claim owner can rewrite both from the browser. The legitimate
-- writers are docusign-webhook (card success path) and stripe-webhook (ACH settle path), both service-role clients
-- (gh-1759). No page, React component or SQL function writes either column on public.claims (the
-- platform_fee_amount keys in contractor-bid-form.html and react-app/.../bid/[claimId]/utils.ts are
-- send-bid-confirmation request bodies, not claims writes).
--
-- Change. One new SECURITY INVOKER trigger function, claims_guard_fee_stripe_columns(), and one trigger,
-- claims_guard_fee_stripe_columns, BEFORE INSERT OR UPDATE OF platform_fee_stripe_id, platform_fee_amount ON
-- public.claims. For client callers (the test the live claims guards use: current_user is anon or authenticated,
-- the JWT role is not service_role, the caller is not an admin):
--   - INSERT with either column non-NULL is refused 42501 (NULL or omitted is fine);
--   - UPDATE that changes either column (either direction, including clearing) is refused 42501. A value
--     re-sent unchanged is not a change.
-- service_role (every Edge Function), admins and owner-level (SECURITY DEFINER, postgres-owned) sessions are
-- untouched. SECURITY INVOKER on purpose: current_user must be the caller.
--
-- ORDER. This is a SEPARATE trigger and function from gh2491_claims_platform_fee_charged_guard (PR #2704),
-- gh2626_claims_award_columns_guard (PR #2737 edits it), gh2519_quotes_server_set_fee and gh2564_quotes_selected_price_lock.
-- It re-creates none of their functions and touches none of their objects, so it can be applied before or after any
-- of them, in any order; the proof run applies it first, last and in the middle and rolls it back in each case.
-- Because it is a distinct trigger, its rollback removes only its own two objects.
--
-- Not changed: any existing trigger or guard function, any policy, any grant, any data.
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or REVOKE.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_guard_fee_stripe_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.platform_fee_stripe_id IS NOT NULL OR NEW.platform_fee_amount IS NOT NULL THEN
        RAISE EXCEPTION 'claims: platform_fee_stripe_id and platform_fee_amount can only be set by service_role or an admin (gh-2710)'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.platform_fee_stripe_id IS DISTINCT FROM OLD.platform_fee_stripe_id
       OR NEW.platform_fee_amount IS DISTINCT FROM OLD.platform_fee_amount THEN
      RAISE EXCEPTION 'claims: platform_fee_stripe_id and platform_fee_amount can only be changed by service_role or an admin (gh-2710)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_fee_stripe_columns() IS
  'gh-2710: BEFORE INSERT OR UPDATE OF platform_fee_stripe_id, platform_fee_amount guard on public.claims. Client roles (anon, authenticated) that are not admins cannot create a claim with either column set and cannot change either on UPDATE (42501); an unchanged value is not a change. service_role (the payment webhooks), admins and owner-level sessions are untouched.';

DROP TRIGGER IF EXISTS claims_guard_fee_stripe_columns ON public.claims;
CREATE TRIGGER claims_guard_fee_stripe_columns
  BEFORE INSERT OR UPDATE OF platform_fee_stripe_id, platform_fee_amount ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_guard_fee_stripe_columns();

COMMIT;
