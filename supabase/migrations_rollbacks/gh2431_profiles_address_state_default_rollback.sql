-- STATUS (gh-1438, as of 2026-10-06T20:30Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2431_profiles_address_state_default (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2431; the function text below is the live handle_new_user() read 2026-10-06 (md5 8d540450...)
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2431 ROLLBACK for supabase/migrations_drafts/gh2431_profiles_address_state_default.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move
-- it into supabase/migrations/ -- the CLI would replay it FORWARD and undo the
-- fix it exists to revert.
--
-- Restores the previous behaviour exactly: DEFAULT 'IN' on
-- profiles.address_state and the previous handle_new_user() body. It does not
-- touch any row. Profiles created between the forward migration and this
-- rollback keep their NULL address_state (nothing here rewrites data).

BEGIN;

ALTER TABLE public.profiles ALTER COLUMN address_state SET DEFAULT 'IN'::text;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, address_state, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    'IN',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

COMMIT;
