-- gh-1961: auto-flag internal test accounts is_test at creation
--
-- DRAFT. NOT APPLIED. Lives in migrations_drafts/ per this directory's
-- contract (supabase/migrations/README.md): supabase/migrations/ holds only
-- SQL already approved AND applied in production, because the Supabase CLI
-- replays that directory forward onto every fresh branch. Promote this file
-- (renamed to a 14-digit UTC timestamp prefix, moved into
-- supabase/migrations/) only after Dustin approves the apply and it is
-- actually run. Same posture as supabase/migrations_drafts/gh1763_is_test_repair.sql.
--
-- APPLYING is D-182 Tier 3 (flagged Tier 3A per the CTO's ruling on
-- issuecomment-5698032041) and is Dustin's call, full stop -- this file does
-- not run itself and nothing in this repo auto-applies it.
--
-- Problem (issuecomment-5698032041, dustinstohler1-dotcom, 2026-09-16T13:12:45Z,
-- on #1961): "Still owed, not done here: the probe path setting is_test at
-- creation. The CTO RUN 33 harness created profiles through the real signup
-- UI, and nothing marks an @otterquote-internal.test email as test at
-- insert. The next concrete step is a DB default or trigger keyed on that
-- domain, as a Tier 3A migration."
--
-- Measured fact (2026-09-16, two separate probe batches, live Supabase
-- project yeszghaspzwwstvsrioa): public.handle_new_user() never reads
-- NEW.email for is_test purposes (it only copies it into profiles.email);
-- public.profiles.is_test defaults to false; every @otterquote-internal.test
-- signup that goes through the real signup UI therefore lands
-- is_test = false and has to be corrected by hand (13 rows flipped by hand
-- today across this issue and the sibling FYI on issuecomment-5696752753).
--
-- This migration is purely ADDITIVE: it adds one new BEFORE INSERT trigger
-- and its trigger function on public.profiles. It does NOT modify
-- public.handle_new_user() or any other existing object.
--
-- Design choice -- read NEW.email directly instead of looking up auth.users:
-- live schema (checked via SELECT against yeszghaspzwwstvsrioa) shows
-- public.profiles already has its own `email` column, populated straight
-- from auth.users.email by handle_new_user()'s own INSERT
-- (INSERT INTO public.profiles (id, email, full_name, address_state,
-- created_at, updated_at) VALUES (NEW.id, NEW.email, ...)). Because that
-- INSERT statement's column list is exactly what a BEFORE INSERT trigger on
-- profiles sees as NEW, NEW.email is already populated by the time this
-- trigger fires -- no separate auth.users lookup is needed for the
-- signup-UI path this issue is about. The function still runs
-- SECURITY DEFINER with search_path pinned (matching handle_new_user()'s own
-- convention) so behavior is identical regardless of which role performs the
-- INSERT (e.g. a service-role backfill or test harness insert that does not
-- go through handle_new_user at all).
--
-- Behavior: on INSERT into public.profiles, if NEW.email ends with
-- '@otterquote-internal.test' (case-insensitive), set NEW.is_test := true.
-- Never sets is_test to false in any branch -- an explicit true supplied by
-- the caller, or a later legitimate hand-correction, is never undone by
-- this trigger; a non-matching or NULL email simply leaves is_test as
-- whatever the INSERT already carried (default false).
--
-- Idempotent by construction: CREATE OR REPLACE FUNCTION and
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER both tolerate being run twice with
-- no error and no behavior change (verified locally -- see PR body).
--
-- Scope note on claims/contractors propagation (see PR body QUESTIONS):
-- this migration does NOT propagate is_test from profiles onto claims or
-- contractors at creation. Measured live 2026-09-16 against
-- yeszghaspzwwstvsrioa: no existing trigger does that today --
-- claims_copy_first_touch (BEFORE INSERT on claims) copies only UTM /
-- first-touch columns from the owning profile, never is_test; and
-- contractors_freeze_privileged_columns (BEFORE INSERT on contractors)
-- unconditionally forces NEW.is_test := false on insert, independent of the
-- owning profile's flag. #1763's PR (cross-table guard) repairs a data
-- disagreement on 7 existing rows; it does not add a live propagation path
-- either. Widening this migration to add that propagation was judged out of
-- scope for #1961 and is raised as a question on the PR instead of acted on
-- here.

begin;

create or replace function public.set_is_test_for_internal_test_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if NEW.email is not null
     and lower(NEW.email) like '%@otterquote-internal.test' then
    NEW.is_test := true;
  end if;

  return NEW;
end;
$fn$;

comment on function public.set_is_test_for_internal_test_domain() is
  'gh-1961: BEFORE INSERT trigger fn on public.profiles. Sets NEW.is_test '
  'true when NEW.email ends with @otterquote-internal.test (case-'
  'insensitive). Never sets is_test false. Purely additive -- does not '
  'read or modify handle_new_user() or any other object.';

drop trigger if exists profiles_set_is_test_for_internal_domain on public.profiles;

create trigger profiles_set_is_test_for_internal_domain
  before insert on public.profiles
  for each row
  execute function public.set_is_test_for_internal_test_domain();

-- Manual rollback (reference only -- this migration is purely additive, so
-- reverting it is exactly undoing the two objects it created; nothing else
-- to unwind and no data was touched):
--   drop trigger if exists profiles_set_is_test_for_internal_domain on public.profiles;
--   drop function if exists public.set_is_test_for_internal_test_domain();

commit;
