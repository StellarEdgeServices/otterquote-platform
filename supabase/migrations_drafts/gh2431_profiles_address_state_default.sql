-- STATUS (gh-1438, as of 2026-10-07T20:19:40Z): APPLIED
-- FILE ROLE: forward file of set gh2431_profiles_address_state_default (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: applied as ledger version 20261007201941 (name gh2431_profiles_address_state_default) under R-097; profiles.address_state column_default is NULL (was 'IN'::text) and handle_new_user() no longer writes address_state; proof run before and after the apply is on #2431 (R-097 EXECUTED)
-- REPO COPY: supabase/migrations/20261007201941_gh2431_profiles_address_state_default.sql (same statements); rollback and pre-flight in supabase/migrations_rollbacks/
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2431: stop seeding every new homeowner profile with address_state = 'IN'.
--
-- Problem: profiles.address_state has DEFAULT 'IN' and handle_new_user() also
-- hard-codes 'IN', so a homeowner who has not entered a state yet is stored as
-- an Indiana homeowner. trade-selector.html copies that value into
-- claims.property_state, which the D-344 state gate (FL, LA, TX blocked) and the
-- gh-2421 out-of-state alert both read. An out-of-state homeowner could be
-- stored as IN and bypass both.
--
-- Change (Tier 3B: a column default and a live auth-trigger function):
--   1. ALTER COLUMN address_state DROP DEFAULT (catalog-only; no row is read or
--      rewritten).
--   2. CREATE OR REPLACE public.handle_new_user() with the live body minus the
--      address_state column and its hard-coded 'IN' value (two lines). Every
--      other line is byte-identical to the live function (md5 prefix 8d540450
--      before; diff in the PR). The existing trigger on_auth_user_created is
--      reused; no second trigger is added.
--
-- NOT touched: any existing row (existing 'IN' values that may be defaults are
-- a separate data decision, see the PR), contractors.address_state (also
-- DEFAULT 'IN', a different table and a different question), the state gate.
-- A NULL address_state is already handled by every reader (see the PR table).
-- The gate does not gate a NULL property_state (existing, tested behaviour).
--
-- Rollback: supabase/migrations_rollbacks/gh2431_profiles_address_state_default_rollback.sql
-- NOT APPLIED by the authoring session. Apply only after REVIEW and the R-097 window.

BEGIN;

ALTER TABLE public.profiles ALTER COLUMN address_state DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

COMMIT;
