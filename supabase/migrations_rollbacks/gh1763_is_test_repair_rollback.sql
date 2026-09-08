-- gh-1763 ROLLBACK for gh1763_is_test_repair.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp and
-- never move it into supabase/migrations/ -- the CLI would replay it
-- FORWARD and silently undo the repair it exists to revert. See
-- MIGRATIONS-RECONCILIATION-385.md, defect 2, for the prior incident this
-- exact mistake caused.
--
-- Reverts public.profiles.is_test back to false on the same 7 ids -- i.e.
-- back to the disagreeing (broken) state the forward migration exists to
-- fix. Only run this if the repair itself is found to be wrong (e.g. one of
-- the 7 rows turns out NOT to be a test fixture after all, on further
-- review post-apply). This does not delete anything and does not touch
-- contractors.is_test -- it is the exact inverse of the forward UPDATE and
-- nothing more.

begin;

-- Row-count assertion, mirroring the forward migration's guard: refuses to
-- run unless production is in the exact post-forward-migration state this
-- rollback expects to find it in.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.profiles p
  where p.id in (
    '67da903b-ac48-4287-846c-0052583d5282',
    'e371c617-8a24-492e-9911-47c85705ebb4',
    '3ea4d929-b916-4cc9-a285-d052df397992',
    'ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c',
    '92d669a8-c02a-42c1-9f52-53b7efd06ddf',
    'eb7dace0-d26b-4a2f-adc3-7762459772c1',
    'd4def812-aebc-444c-bdee-f68bccc19b61'
  )
  and p.is_test = true;

  if v_count <> 7 then
    raise exception
      'gh-1763 ROLLBACK GUARD: expected exactly 7 profiles rows with is_test=true '
      'among the named ids, found %. State does not match the '
      'post-forward-migration baseline -- STOP and confirm what actually ran '
      'before reverting.', v_count;
  end if;
end $$;

update public.profiles
set is_test = false
where id in (
  '67da903b-ac48-4287-846c-0052583d5282',
  'e371c617-8a24-492e-9911-47c85705ebb4',
  '3ea4d929-b916-4cc9-a285-d052df397992',
  'ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c',
  '92d669a8-c02a-42c1-9f52-53b7efd06ddf',
  'eb7dace0-d26b-4a2f-adc3-7762459772c1',
  'd4def812-aebc-444c-bdee-f68bccc19b61'
)
and is_test = true;

commit;
