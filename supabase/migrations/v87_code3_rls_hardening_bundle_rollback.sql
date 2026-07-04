-- Rollback: v87_code3_rls_hardening_bundle_rollback.sql
-- Reverts: v87_code3_rls_hardening_bundle.sql
-- Author: Claude Code (automated)
-- Date: 2026-07-03
-- WARNING: Only run if the forward migration must be undone in production.
--          Restores the permissive pre-migration state (known-vulnerable policies/trigger actor).

BEGIN;

-- (1) contractor_templates guard — remove
DROP TRIGGER IF EXISTS trg_templates_privileged_guard ON public.contractor_templates;
DROP FUNCTION IF EXISTS public.enforce_template_privileged_columns();

-- (2) contractors guard — remove
DROP TRIGGER IF EXISTS trg_contractors_privileged_guard ON public.contractors;
DROP FUNCTION IF EXISTS public.enforce_contractor_privileged_columns();

-- helper — remove
DROP FUNCTION IF EXISTS public.request_is_privileged();

-- (3) platform_settings — restore original permissive policy
DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
DROP POLICY IF EXISTS "Anyone authenticated can read settings" ON public.platform_settings;
CREATE POLICY "Anyone authenticated can read settings" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (true);

-- (4) log_bid_accepted — restore original body (verbatim prosrc captured 2026-07-03,
--     SECURITY DEFINER + search_path preserved per pg_proc prosecdef/proconfig)
CREATE OR REPLACE FUNCTION public.log_bid_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ BEGIN IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN INSERT INTO activity_log (user_id, event_type, title, metadata) SELECT NEW.contractor_id, 'bid_accepted', 'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'), jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price) FROM claims c WHERE c.id = NEW.claim_id; END IF; RETURN NEW; END; $$;

COMMIT;
