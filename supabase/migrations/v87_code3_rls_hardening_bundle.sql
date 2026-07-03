-- Migration: v87_code3_rls_hardening_bundle
-- Author: Claude Code (automated, run-work CODE-3 session rw-f22-20260703T214037-c1a7)
-- Date: 2026-07-03
-- D-numbers: D-182 (Tier 3), D-220/D-261 (approval tiers), D-221 (deploy path)
-- Approvals: [DUSTIN-APPROVED 2026-07-03 via qz-20260703] comments on 86e1xpb3h and 86e1zh5m9;
--            86e1wquxq / 86e1wpx7y items dispatched to CODE-3 by Dustin 2026-07-03.
-- Rollback: v87_code3_rls_hardening_bundle_rollback.sql
-- Pre-flight: v87_code3_rls_hardening_bundle_pre-flight.md
--
-- Summary: CODE-3 RLS/trigger hardening bundle:
--   (1) contractor_templates — freeze admin-review columns (status, reviewed_by, reviewed_at,
--       admin_notes) against contractor self-writes via BEFORE UPDATE trigger (86e1xpb3h #2 HIGH).
--   (2) contractors — freeze status/approval/gate columns against self-writes via BEFORE UPDATE
--       trigger (86e1wquxq #1 HIGH + #2).
--   (3) platform_settings — authenticated SELECT restricted to the approved public-key whitelist
--       (86e1zh5m9; approved: whitelist genuinely-public keys, rest service-role only).
--   (4) log_bid_accepted() — write the contractor's auth user_id (not contractors.id) into
--       activity_log.user_id (86e1wpx7y #2).
--
-- NOT included: 86e1xpb3h #1 / 86e1wquxq #3 (contractor_cert_verifications wrong-column RLS) —
-- live re-verified 2026-07-03: policies already use the correct contractors.user_id join. Closed.
--
-- Design note: column restriction is TRIGGER-enforced, not column-level GRANTs, because the admin
-- React pages perform direct table UPDATEs under the `authenticated` role — column-level REVOKEs
-- would break admin approve/reject. Triggers allow: direct DB connections (no JWT: migrations,
-- pg_cron, psql), service_role JWTs (EFs), is_admin_email() admins, and — for contractor_templates
-- only — contractors with template_review_role='admin' (matches the existing admin policy).

BEGIN;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public.request_is_privileged()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT current_setting('request.jwt.claims', true) IS NULL
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR public.is_admin_email();
$$;

-- ---------------------------------- (1) contractor_templates column guard
CREATE OR REPLACE FUNCTION public.enforce_template_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.request_is_privileged()
     OR EXISTS (SELECT 1 FROM public.contractors
                 WHERE user_id = (SELECT auth.uid())
                   AND template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.status         IS DISTINCT FROM OLD.status
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_templates_privileged_guard ON public.contractor_templates;
CREATE TRIGGER trg_templates_privileged_guard
  BEFORE UPDATE ON public.contractor_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_template_privileged_columns();

-- ----------------------------------------- (2) contractors column guard
CREATE OR REPLACE FUNCTION public.enforce_contractor_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.request_is_privileged() THEN
    RETURN NEW;
  END IF;
  IF NEW.status                  IS DISTINCT FROM OLD.status
     OR NEW.verified             IS DISTINCT FROM OLD.verified
     OR NEW.approved_at          IS DISTINCT FROM OLD.approved_at
     OR NEW.rejected_at          IS DISTINCT FROM OLD.rejected_at
     OR NEW.rejection_reason     IS DISTINCT FROM OLD.rejection_reason
     OR NEW.license_verified     IS DISTINCT FROM OLD.license_verified
     OR NEW.license_verified_at  IS DISTINCT FROM OLD.license_verified_at
     OR NEW.insurance_verified   IS DISTINCT FROM OLD.insurance_verified
     OR NEW.insurance_verified_at IS DISTINCT FROM OLD.insurance_verified_at
     OR NEW.cert_status          IS DISTINCT FROM OLD.cert_status
     OR NEW.template_review_role IS DISTINCT FROM OLD.template_review_role
     OR NEW.rating               IS DISTINCT FROM OLD.rating
     OR NEW.review_count         IS DISTINCT FROM OLD.review_count
     OR NEW.admin_notes          IS DISTINCT FROM OLD.admin_notes
     OR NEW.legacy_pre_approval  IS DISTINCT FROM OLD.legacy_pre_approval
     OR NEW.is_test              IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'contractors: status/approval/gate columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contractors_privileged_guard ON public.contractors;
CREATE TRIGGER trg_contractors_privileged_guard
  BEFORE UPDATE ON public.contractors
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contractor_privileged_columns();

-- ------------------------------------- (3) platform_settings whitelist
DROP POLICY IF EXISTS "Anyone authenticated can read settings" ON public.platform_settings;
DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (key IN ('D204_HARD_FILTER',
                 'hover_measurement_price',
                 'platform_fee_percentage',
                 'skip_hover_in_test'));

-- --------------------------------------- (4) log_bid_accepted actor fix
CREATE OR REPLACE FUNCTION public.log_bid_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
