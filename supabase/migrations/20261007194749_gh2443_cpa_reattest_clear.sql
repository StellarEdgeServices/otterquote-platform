-- gh-2443 (R-097 EXECUTED, 2026-10-07T19:47:48Z): filed copy of supabase/migrations_drafts/gh2443_cpa_reattest_clear.sql under its REAL
-- applied ledger version 20261007194749 (supabase_migrations.schema_migrations, name=gh2443_cpa_reattest_clear; production yeszghaspzwwstvsrioa).
-- The bytes sent to production were the draft's, fetched from main at the apply; executable SQL below is the draft's, unchanged.
-- Rollback and pre-flight: supabase/migrations_rollbacks/gh2443_cpa_reattest_clear_rollback.sql and gh2443_cpa_reattest_clear_pre-flight.md.
--
-- gh-2443: contractors_freeze_privileged_columns: let a contractor clear ONLY their own CPA re-attestation flag.
-- Pre-flight: supabase/migrations_rollbacks/gh2443_cpa_reattest_clear_pre-flight.md  Proof (rolled back, is_test rows only): supabase/tests/gh2443_cpa_reattest_clear_proof.sql
--
-- What changes: in the UPDATE branch, the pin NEW.needs_cpa_reattestation := OLD.needs_cpa_reattestation becomes a
-- clear-only CASE. The flag is cleared only when the stored flag is true, the write sets it false, and the written
-- cpa_version equals the single is_current row of public.cpa_versions (NULL when none is current, so it stays pinned).
-- It can never be set true, never cleared on a stale or invented version. The INSERT branch, the admin and
-- service_role exemptions, every other pin, and enforce_contractor_privileged_columns() are not touched.
-- No second trigger and no new function: this replaces the body of the existing function (CI enforces one guard).

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
    NEW.has_payment_method             := false;      -- gh-1425 path 1
    NEW.stripe_payment_method_id       := NULL;       -- gh-1425 path 1
    NEW.stripe_payment_method_last4    := NULL;       -- gh-1425 path 1
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
  -- gh-2443: clear-only exception. A contractor may turn OFF their own re-attestation flag, and only
  -- while writing the CURRENT agreement version. Anything else stays pinned (never set true, never
  -- cleared on a stale or invented version, never cleared when no version is current).
  NEW.needs_cpa_reattestation        := CASE
    WHEN OLD.needs_cpa_reattestation = true
     AND NEW.needs_cpa_reattestation = false
     AND NEW.cpa_version = (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1)
    THEN false
    ELSE OLD.needs_cpa_reattestation
  END;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;              -- gh-1425 path 1
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;        -- gh-1425 path 1
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;     -- gh-1425 path 1
  RETURN NEW;
END;
$function$
;
