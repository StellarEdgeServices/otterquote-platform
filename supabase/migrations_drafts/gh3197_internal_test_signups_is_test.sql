-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: forward file of set gh3197_internal_test_signups_is_test (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa), pg_get_functiondef / pg_trigger / SELECT only:
--   set_is_test_for_internal_test_domain() matches only '%@otterquote-internal.test'; is_internal_test_email() also accepts
--   stellaredgeservices.com, tryotterquote.com, stohlerroof.com, otterquote.com and gmail dustinstohler1 / stacymortonfitfan (+tags).
--   38 profiles with an internal-test email have is_test<>true (gmail 18, stellaredgeservices 13, otterquote 4, stohlerroof 2,
--   tryotterquote 1); 3 claims owned by those profiles have is_test<>true. No claims trigger inherits profiles.is_test.
--   No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3197_internal_test_signups_is_test
-- GitHub: #3197. Tier: 3B (function replacement, R-097 24-hour notice; CTO applies).
-- Rollback: supabase/migrations_drafts/gh3197_internal_test_signups_is_test_rollback.sql
-- Pre-flight / proof plan: supabase/migrations_drafts/gh3197_internal_test_signups_is_test_pre-flight.md
--
-- Why: trigger profiles_set_is_test_for_internal_domain (BEFORE INSERT on profiles) runs set_is_test_for_internal_test_domain(),
-- which has its own hard-coded domain list and so never saw the domains gh-2154 added to is_internal_test_email(). claims has no
-- rule that copies profiles.is_test, so a test homeowner's claim lands is_test=false and is counted as a real homeowner.
--
-- Change 1: set_is_test_for_internal_test_domain() decides with is_internal_test_email(NEW.email). Only raises false to true.
-- Change 2: claims_guard_referral_columns() (the one claims guard trigger; CI test tests/gh2479-static-born-state-guard.mjs pins it)
--   gets one extra INSERT-only block that copies profiles.is_test (id = NEW.user_id) onto the new claim. It sits OUTSIDE the
--   client-role test so service_role / admin inserts inherit too. Every earlier rule is kept verbatim; no second trigger, no new
--   function, no new RAISE (the CI test counts exactly three 42501 refusals). Only raises false to true, never lowers a true.
--   The function stays SECURITY INVOKER: a signed-in owner reads their own profiles row (profiles_user_read), service_role bypasses RLS.
-- Not in this file: a backfill UPDATE of the 38 profiles / 3 claims (see the pre-flight and the sibling gh3197_backfill_internal_test_is_test.sql).

BEGIN;

CREATE OR REPLACE FUNCTION public.set_is_test_for_internal_test_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
begin
  if NEW.email is not null
     and public.is_internal_test_email(NEW.email) then
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
  -- gh-3197: a new claim inherits is_test from its owner's profile (raise only, never lower)
  IF TG_OP = 'INSERT'
     AND NEW.is_test IS NOT TRUE
     AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.is_test IS TRUE) THEN
    NEW.is_test := true;
  END IF;
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

COMMIT;
