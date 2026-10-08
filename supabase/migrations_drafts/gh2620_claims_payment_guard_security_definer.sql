-- STATUS (gh-1438, as of 2026-10-08T16:39:44Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2620_claims_payment_guard_security_definer (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: production read-only 2026-10-08: claims_enforce_payment_method_on_award() prosecdef=false, trigger claims_payment_method_guard enabled; rolled-back proof in supabase/tests/gh2620_claims_payment_guard_proof.sql (results on #2620)
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2620: a homeowner awarding a bid from the React app is refused for every homeowner.
--
-- Cause: trigger claims_payment_method_guard (BEFORE UPDATE on public.claims) runs
-- claims_enforce_payment_method_on_award(), which reads public.contractors.has_payment_method.
-- The function is SECURITY INVOKER, so it runs as the homeowner. contractors has RLS and its
-- only SELECT policies are the admin email and user_id = auth.uid() (the contractor's own row),
-- so the homeowner sees zero rows, v_has_pm stays NULL, and the function raises
-- contractor_no_payment_method on every award. bids.html is unaffected because accept_bid()
-- is SECURITY DEFINER and reads contractors as its owner.
--
-- Change (Tier 3B: a live trigger function on the award path, money path):
--   1. CREATE OR REPLACE the function with SECURITY DEFINER. The body and the pinned
--      search_path ('public', 'pg_temp') are byte-identical to the live function.
--   2. REVOKE EXECUTE from PUBLIC, anon and authenticated. A trigger function is not callable
--      through PostgREST (it returns trigger) and Postgres checks EXECUTE only at CREATE TRIGGER,
--      not when the trigger fires, so only the owner and service_role keep it.
-- Not changed: the trigger, the contractors RLS policies (no homeowner SELECT is added, so a
-- homeowner still cannot read contractor rows), accept_bid(), any data.
-- The function exposes only a yes/no outcome (raise or not) about one contractor's payment-method
-- flag, and only for a contractor the caller has just set on a claim row they may already update.
--
-- Rollback: supabase/migrations_rollbacks/gh2620_claims_payment_guard_security_definer_rollback.sql
-- NOT APPLIED by the authoring session. Apply only after REVIEW and the R-097 window.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_enforce_payment_method_on_award()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_has_pm boolean;
BEGIN
  IF NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded' THEN
    IF NEW.selected_contractor_id IS NULL THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT has_payment_method INTO v_has_pm
      FROM public.contractors
     WHERE id = NEW.selected_contractor_id;

    IF v_has_pm IS NOT TRUE THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claims_enforce_payment_method_on_award() FROM PUBLIC, anon, authenticated;

COMMIT;
