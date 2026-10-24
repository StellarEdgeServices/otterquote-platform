-- gh-2995 ROLLBACK: remove accept_cpa() and the append-only table.
-- Run manually only if the gh-2995 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- DATA WARNING: this DROPS the acceptance records. Before running it on production, export them
-- (COPY / SELECT * FROM public.contractor_cpa_acceptances) and attach the export to the issue; they are consent evidence.
-- contractors.cpa_version / cpa_accepted_at / agreement_version and the activity_log rows already written are NOT reverted
-- (they are the same columns the pages wrote before). record_cpa_ip() was never touched, so pages on the old path work again.
-- Pages that call rpc('accept_cpa') must be reverted first (or acceptance fails with a missing-function error).
-- To restore the table's rows after a rollback, re-run the forward file and re-insert the export.

-- Restore the pre-gh-2995 freeze body (the live body read 2026-10-24, with the gh-2443 clear-only exception).
-- Revert the pages first: after this, pre-approval/dashboard writes of the acceptance columns work again only if the old page code is back.
CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;
    NEW.stripe_payment_method_id       := NULL;
    NEW.stripe_payment_method_last4    := NULL;
    RETURN NEW;
  END IF;

  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  NEW.needs_cpa_reattestation        := CASE
    WHEN OLD.needs_cpa_reattestation = true
     AND NEW.needs_cpa_reattestation = false
     AND NEW.cpa_version = (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1)
    THEN false
    ELSE OLD.needs_cpa_reattestation
  END;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.accept_cpa(text);
DROP TABLE IF EXISTS public.contractor_cpa_acceptances;
DROP FUNCTION IF EXISTS public.cpa_acceptances_append_only();
