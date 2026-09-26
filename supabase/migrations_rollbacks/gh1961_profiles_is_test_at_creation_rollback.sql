-- gh-1961 ROLLBACK for gh1961_profiles_is_test_at_creation.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp and
-- never move it into supabase/migrations/ -- the CLI would replay it
-- FORWARD and silently undo the fix it exists to revert. Same convention as
-- supabase/migrations_rollbacks/gh1763_is_test_repair_rollback.sql.
--
-- The forward migration is purely additive (two new BEFORE INSERT triggers
-- and their two trigger functions -- one pair on public.profiles, one pair
-- on public.contractors). This rollback is exactly the inverse: drop the
-- two triggers, then the two functions. It does not touch
-- handle_new_user(), contractors_freeze_privileged_columns(), or any row
-- data -- there is no data to restore, because the forward migration never
-- wrote a row itself (it only changes what future INSERTs do).
--
-- Only run this if the forward migration is found to be wrong after it has
-- been applied (e.g. the alphabetical trigger-ordering assumption turns out
-- not to hold on the target Postgres version/config -- see the forward
-- migration's own header and the companion .test.sql for how that was
-- verified before ever proposing this).

begin;

drop trigger if exists contractors_zz_inherit_profile_is_test on public.contractors;
drop function if exists public.contractors_inherit_profile_is_test();

drop trigger if exists profiles_set_is_test_for_internal_domain on public.profiles;
drop function if exists public.set_is_test_for_internal_test_domain();

commit;

-- Post-condition (verify manually after rollback):
--   select count(*) from pg_trigger
--   where tgname in ('contractors_zz_inherit_profile_is_test',
--                     'profiles_set_is_test_for_internal_domain');
--   -- expect: 0
--
--   select count(*) from pg_proc
--   where proname in ('contractors_inherit_profile_is_test',
--                      'set_is_test_for_internal_test_domain')
--     and pronamespace = 'public'::regnamespace;
--   -- expect: 0
