-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: rollback file of set gh3197_internal_test_signups_is_test
-- EVIDENCE: bodies below are the live definitions read from production 2026-10-30 (pg_get_functiondef, project yeszghaspzwwstvsrioa).
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: restores set_is_test_for_internal_test_domain() and claims_guard_referral_columns() to their pre-gh-3197 bodies,
-- then drops the helper is_internal_test_user(uuid) that this set added (after the guard no longer calls it). Rows already flagged is_test=true by the new rules are NOT reverted (lowering them would re-inflate real-homeowner counts).

BEGIN;

CREATE OR REPLACE FUNCTION public.set_is_test_for_internal_test_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
begin
  if NEW.email is not null
     and lower(NEW.email) like '%@otterquote-internal.test' then
    NEW.is_test := true;
  end if;

  return NEW;
end;
$fn$;

CREATE OR REPLACE FUNCTION public.claims_guard_referral_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      -- the window anchor is server time, never a browser-supplied value
      NEW.created_at := now();
      -- gh-2479 born state: a client-created claim starts at the beginning of the flow
      IF COALESCE(NEW.status NOT IN ('documents_needed', 'draft'), true)
         OR NEW.selected_contractor_id IS NOT NULL
         OR NEW.selected_bid_amount IS NOT NULL
         OR NEW.completion_date IS NOT NULL
         OR NEW.contract_signed_at IS NOT NULL THEN
        RAISE EXCEPTION 'claims: a new claim must start in its initial state; status, selected contractor, bid amount, signing and completion are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF COALESCE(
           (NEW.referral_id IS DISTINCT FROM OLD.referral_id)
           OR (NEW.completion_date IS DISTINCT FROM OLD.completion_date)
           OR (NEW.created_at IS DISTINCT FROM OLD.created_at),
           true) THEN
        RAISE EXCEPTION 'claims: referral_id, completion_date and created_at can only be changed by service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      -- gh-2479 born state: without this an initial-state INSERT plus one UPDATE reaches the same row
      IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
         AND NOT COALESCE(NEW.status IN ('active', 'waitlisted', 'submitted', 'awarded'), false) THEN
        RAISE EXCEPTION 'claims: status can only be changed to active, waitlisted, submitted or awarded by the claim owner; other changes need service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

DROP FUNCTION IF EXISTS public.is_internal_test_user(uuid);

COMMIT;
