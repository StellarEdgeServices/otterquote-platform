-- Phase 16 RLS Unit 4 — freeze contractor_templates D-199 verdict (86e1xpb3h)
-- D-220 Tier-3, Dustin-approved 2026-06-18; D-221 Path A
-- contractor_templates_self granted ALL => a contractor could self-set status='validated' and
-- bid with an unvalidated/non-compliant contract template (D-199 gate bypass). This trigger lets
-- contractors write template CONTENT but never the verdict; content changes force re-validation
-- (also closes the validate-then-swap-the-PDF bypass). service_role (validate-contract-template EF),
-- admin email, and real reviewers (template_review_role='admin') are exempt.
-- Rollback: DROP TRIGGER + DROP FUNCTION (companion rollback file).

CREATE OR REPLACE FUNCTION public.contractor_templates_freeze_verdict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Exempt service_role (EF/system), the admin account, and appointed template reviewers.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF coalesce(auth.jwt() ->> 'email','') = 'dustinstohler1@gmail.com' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.contractors c
             WHERE c.user_id = (select auth.uid()) AND c.template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
    NEW.reviewed_by       := NULL;
    NEW.reviewed_at       := NULL;
    NEW.admin_notes       := NULL;
    RETURN NEW;
  END IF;

  -- Regular contractor UPDATE: verdict/admin fields are never theirs to write.
  NEW.reviewed_by  := OLD.reviewed_by;
  NEW.reviewed_at  := OLD.reviewed_at;
  NEW.admin_notes  := OLD.admin_notes;

  IF (NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path)
     OR (NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides)
     OR (NEW.trade IS DISTINCT FROM OLD.trade)
     OR (NEW.funding_type IS DISTINCT FROM OLD.funding_type) THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
  ELSE
    NEW.status            := OLD.status;
    NEW.validation_result := OLD.validation_result;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contractor_templates_freeze_verdict
  BEFORE INSERT OR UPDATE ON public.contractor_templates
  FOR EACH ROW EXECUTE FUNCTION public.contractor_templates_freeze_verdict();
