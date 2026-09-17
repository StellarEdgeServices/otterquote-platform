-- gh-1961: auto-flag internal test accounts is_test at creation
--
-- DRAFT. NOT APPLIED. Lives in migrations_drafts/ per this directory's
-- contract (supabase/migrations/README.md): supabase/migrations/ holds only
-- SQL already approved AND applied in production, because the Supabase CLI
-- replays that directory forward onto every fresh branch. Promote this file
-- (renamed to a 14-digit UTC timestamp prefix, moved into
-- supabase/migrations/) only after Dustin approves the apply and it is
-- actually run. Same posture as supabase/migrations_drafts/gh1763_is_test_repair.sql.
-- Rollback and pre-flight docs: gh1961_profiles_is_test_at_creation_rollback.sql
-- and gh1961_profiles_is_test_at_creation_pre-flight.md in
-- supabase/migrations_rollbacks/.
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
-- Measured fact (2026-09-16, live Supabase project yeszghaspzwwstvsrioa):
-- public.handle_new_user() never reads NEW.email for is_test purposes (it
-- only copies it into profiles.email); public.profiles.is_test defaults to
-- false; every @otterquote-internal.test signup that goes through the real
-- signup UI therefore lands is_test = false and has to be corrected by hand.
-- Correction: the PR's original header said "13 rows flipped by hand today"
-- -- that number was wrong. Comment issuecomment-5698032041 records exactly
-- 3 rows corrected (`update profiles set is_test = true where id in (...)
-- and is_test = false returning id, is_test;` -> 3 rows, all true); the
-- sibling FYI issuecomment-5696752753 separately reports 2 further probe
-- rows that were already true before any correction. Neither adds to 13.
--
-- This migration is purely ADDITIVE: it adds two new BEFORE INSERT triggers
-- and their trigger functions -- one on public.profiles, one on
-- public.contractors. It does NOT modify public.handle_new_user(),
-- public.contractors_freeze_privileged_columns(), or any other existing
-- object.
--
-- === Part 1: public.profiles ===============================================
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
-- === Part 2: public.contractors (review fix, PR #2002 comment 5706433778) ==
--
-- Review finding B1 (blocking): with Part 1 alone, a UI-created internal
-- test contractor ends up HALF-flagged. Sequence on a real signup, as role
-- `authenticated`: handle_new_user() inserts the profile row, Part 1's
-- trigger sets profiles.is_test := true; the app then inserts into
-- contractors, and the EXISTING trigger contractors_freeze_privileged_columns
-- (BEFORE INSERT OR UPDATE) forces NEW.is_test := false unconditionally in
-- its INSERT branch whenever current_user = 'authenticated' and the caller
-- is not the admin. Correction to this PR's own earlier wording: that
-- trigger does NOT force false "unconditionally" -- only when current_user =
-- 'authenticated' and the caller is not dustinstohler1@gmail.com; a
-- service-role seed keeps whatever value it supplies. Result on the
-- authenticated-signup path: profiles.is_test = true, contractors.is_test =
-- false -- exactly the #1763 cross-table disagreement
-- (scripts/is-test-cross-table-check.py's DISAGREEMENT_SQL), which the daily
-- prod guard (.github/workflows/edge-function-drift.yml, cron 17 9 * * *)
-- asserts must be 0.
--
-- DECIDED cure (Ben, CEO RUN 48, comment 5706433778): additive, no ALTER of
-- any existing object -- add a second new BEFORE INSERT trigger on
-- public.contractors whose name sorts AFTER
-- "contractors_freeze_privileged_columns" alphabetically, so it fires after
-- it. Postgres fires same-timing/same-event triggers on one table in
-- alphabetical order by trigger name (documented CREATE TRIGGER behavior);
-- "contractors_freeze_privileged_columns" < "contractors_zz_inherit_profile_is_test"
-- by ASCII order ('f' < 'z'), and no other existing trigger on
-- public.contractors fires BEFORE INSERT (checked live: the only other
-- BEFORE trigger, trg_contractors_privileged_guard, is BEFORE UPDATE only).
-- Verified empirically, not just by the documented rule: the migration's own
-- test file proves the ordering by observing the freeze trigger's false
-- actually get overwritten to true by this trigger on the same INSERT.
--
-- Behavior: on an END-USER (authenticated) INSERT into public.contractors
-- only, if NEW.is_test is not already true, look up the owning profile
-- (public.profiles.id = NEW.user_id); if that profile's is_test is true,
-- set NEW.is_test := true. Never sets is_test to false. SECURITY DEFINER
-- (matching handle_new_user() and sync_contractor_profile_role()'s own
-- convention) so the profile lookup does not depend on the inserting
-- role's SELECT grants/RLS on profiles -- an authenticated caller only
-- ever supplies their own user_id in practice, but the lookup does not
-- rely on that being enforced.
--
-- === Round 2 (review comment 5707827031) ===================================
--
-- Finding B1 (blocking): the first version of this trigger (no role check)
-- fired for EVERY inserting role, so a service-role INSERT that explicitly
-- set is_test=false got silently overridden to true whenever the owning
-- profile was true. That is exactly the fixture the #564 regression spec
-- uses: tests/e2e/flows/test-world-symmetry.spec.ts scenario S2 creates an
-- internal-domain user (profiles.is_test=true) and then has the
-- service-role admin client INSERT a contractor row with is_test=false, to
-- prove RLS treats that contractor as real and hides seeded test claims
-- from it. The round-1 trigger broke that -- checked against the spec file
-- directly, not just against the reviewer's description of it.
--
-- Cure applied (reviewer-tested, comment 5707827031): scope the override to
-- end-user inserts only, using coalesce(auth.jwt() ->> 'role', '') =
-- 'authenticated'. Deliberately NOT current_user: this function is
-- SECURITY DEFINER, so current_user inside it is always the function's
-- owner, never the calling role -- current_user would never equal
-- 'authenticated' here regardless of who actually made the request, which
-- would have silently disabled the B1 (round 1) fix entirely rather than
-- narrowing it correctly. auth.jwt() reads the request-scoped GUC PostgREST
-- actually sets for the caller's real role. Verified with the real
-- auth.jwt() body (pulled live via pg_get_functiondef against
-- yeszghaspzwwstvsrioa) installed in the companion .test.sql, which now
-- drives it via the request.jwt.claims GUC instead of a static stub, so
-- both the authenticated and non-authenticated branches are actually
-- exercised, not just documented.
--
-- Explicitly out of scope for this round, recorded here so Dustin sees it
-- before approving the apply (per the review's own ask):
--   - The one pre-existing live disagreement row (profiles.is_test=true /
--     contractors.is_test=false for one already-live internal contractor,
--     count read 2026-09-17 against yeszghaspzwwstvsrioa) is left AS-IS.
--     This migration only changes what future INSERTs do; it does not
--     repair existing rows, and doing so would be a data UPDATE (Tier 3B
--     territory per the gh-1763 precedent), not this Tier 3A DDL change.
--   - Whether to also apply this migration to the CI-test project
--     (zsdvaqilfdclwosmiheh, which carries the same
--     contractors_freeze_privileged_columns / trg_contractors_privileged_guard
--     / trg_sync_contractor_profile_role triggers as prod, checked via
--     SELECT) is a SEPARATE explicit decision from applying it to prod --
--     not bundled into this Tier 3A approval. The nightly E2E suite
--     (e2e-nightly.yml) that exercises S2 runs against that project.
--
-- UPDATE-path check (review ask): does contractors_freeze_privileged_columns
-- reset is_test on UPDATE too? Read live via pg_get_functiondef -- no. Its
-- UPDATE branch pins every privileged column, including is_test, to the
-- OLD value ("NEW.is_test := OLD.is_test;"); it never forces false on
-- UPDATE. So once this trigger sets is_test = true at INSERT time, later
-- UPDATEs preserve it -- no separate UPDATE-time trigger is needed here.
--
-- Idempotent by construction (both parts): CREATE OR REPLACE FUNCTION and
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER all tolerate being run twice with
-- no error and no behavior change (verified locally -- see PR body and the
-- companion .test.sql).
--
-- Scope note on claims propagation (see PR body QUESTIONS, still open): this
-- migration does not propagate is_test from profiles onto claims at
-- creation. Measured live 2026-09-16: claims_copy_first_touch (BEFORE INSERT
-- on claims) copies only UTM / first-touch columns from the owning profile,
-- never is_test. Left as a follow-up question, not acted on here.

begin;

-- --- Part 1: public.profiles -----------------------------------------------

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

-- --- Part 2: public.contractors (fires AFTER contractors_freeze_privileged_columns
--             on INSERT, by trigger-name alphabetical order -- "zz" sorts last) ---

create or replace function public.contractors_inherit_profile_is_test()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_profile_is_test boolean;
begin
  -- Round-2 fix (review comment 5707827031, finding B1): only inherit the
  -- flag on an end-user (authenticated) insert. NOT current_user -- this
  -- function is SECURITY DEFINER, so current_user here is always the
  -- function's owner, never the calling role. auth.jwt() ->> 'role' reads
  -- the request-scoped claim PostgREST actually sets for the caller: it is
  -- 'authenticated' for a real end-user request and absent (so this
  -- resolves to '') for a service-role call. Round 1 skipped this check
  -- entirely and so overrode an explicit service-role is_test=false,
  -- breaking #564 test-world-symmetry spec S2.
  if coalesce(auth.jwt() ->> 'role', '') = 'authenticated' then
    if NEW.is_test is not true then
      select p.is_test into v_profile_is_test
      from public.profiles p
      where p.id = NEW.user_id;

      if v_profile_is_test is true then
        NEW.is_test := true;
      end if;
    end if;
  end if;

  return NEW;
end;
$fn$;

comment on function public.contractors_inherit_profile_is_test() is
  'gh-1961 (review fixes, comments 5706433778 and 5707827031): BEFORE INSERT '
  'trigger fn on public.contractors, named to fire after '
  'contractors_freeze_privileged_columns in Postgres''s alphabetical '
  'same-event trigger order. On an end-user authenticated insert only (per '
  'the caller''s JWT role claim, read via auth.jwt(), not current_user, '
  'since this function is SECURITY DEFINER), sets NEW.is_test true when the '
  'owning profile (profiles.id = NEW.user_id) is_test is true. Never sets '
  'is_test false, and never touches a service-role or system insert''s '
  'explicit value (round-2 fix: round 1 overrode an explicit service-role '
  'is_test=false, breaking #564 test-world-symmetry spec S2). Purely '
  'additive -- does not read or modify contractors_freeze_privileged_columns() '
  'or any other object. Closes the #1763 cross-table disagreement that '
  'Part 1 alone would otherwise open on every UI-created internal test '
  'contractor.';

drop trigger if exists contractors_zz_inherit_profile_is_test on public.contractors;

create trigger contractors_zz_inherit_profile_is_test
  before insert on public.contractors
  for each row
  execute function public.contractors_inherit_profile_is_test();

commit;
