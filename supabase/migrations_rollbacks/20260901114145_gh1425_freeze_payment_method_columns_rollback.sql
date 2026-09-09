-- gh-1425 path 1 ROLLBACK: restore both freeze functions to the exact
-- definitions read live from yeszghaspzwwstvsrioa via pg_get_functiondef()
-- on 2026-09-01, immediately before the forward migration was applied.

CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only constrain direct end-user (authenticated) writes. service_role (Edge Functions / cron)
  -- and SECURITY DEFINER system triggers run as a non-'authenticated' role => exempt.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- Admin account is exempt (mirrors the existing admin_update_contractors policy).
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
    RETURN NEW;
  END IF;

  -- UPDATE: pin every privileged column to its stored value (silently ignore change attempts).
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
  NEW.needs_cpa_reattestation        := OLD.needs_cpa_reattestation;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_contractor_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
