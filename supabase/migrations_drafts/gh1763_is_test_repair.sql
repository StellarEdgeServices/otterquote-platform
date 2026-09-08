-- gh-1763: repair profiles.is_test on 7 rows where profiles.is_test and
-- contractors.is_test disagree.
--
-- DRAFT. NOT APPLIED. Lives in migrations_drafts/ per this directory's
-- contract: supabase/migrations/ holds only SQL already approved AND applied
-- in production, because the Supabase CLI replays that directory forward
-- onto every fresh branch. Promote this file (renamed to a 14-digit UTC
-- timestamp prefix, moved into supabase/migrations/) only after Dustin
-- approves the apply and it is actually run.
--
-- APPLYING is D-182 Tier 3 and is Dustin's call, full stop -- this file does
-- not run itself and nothing in this repo auto-applies it.
--
-- TIER NOTE: issue #1763 carries label tier:3a, but per the CTO's own flag
-- on comment 5572645535 ("the migration writes production rows and is
-- tiered by what its pipeline executes, not by its diff... Expect the tier
-- to move and say so in the PR"), this is a data UPDATE against 7 existing
-- production identity rows -- not an additive schema change -- so per
-- D-261/R-097 (migration-author-code Step 8) it is expected to move to Tier
-- 3B (24-hour risk brief) rather than ship under the lightweight Tier 3A
-- 2-hour window. The PR opened from this branch asks @exec:cto to confirm
-- the move and post the R-097 notice; this file does not decide its own tier.
--
-- THE RULE AND THE EXCEPTION (both required in this header per the CTO's
-- own instruction on comment 5572645535 -- "or the next reader will 'fix'
-- it back"):
--
--   RULE: `profiles` is authoritative for identity-level `is_test`;
--   `contractors` mirrors it. Reason (CTO ruling, comment 5572645535,
--   2026-09-07T15:14:04Z): profiles is the row that carries the human, it
--   is what auth.users maps onto, and R-173's entire purpose is "is this a
--   real person." A contractor record is a business object hanging off an
--   identity; when they disagree, the identity wins.
--
--   REJECTED ALTERNATIVE: `contractors` as authoritative, on the argument
--   that it is the row the product actually reads. That is true, and it is
--   exactly why it must not be the source -- a test-seeding path that
--   writes `contractors` and not `profiles` is how these 7 rows happened,
--   and making the written-by-the-buggy-path table authoritative would
--   ratify the bug rather than fix it.
--
--   EXCEPTION, on these 7 rows specifically: applying the rule literally
--   would move `contractors.is_test` to match `profiles.is_test` (i.e. flip
--   all 7 contractors rows to false). But all 7 are
--   `profile_is_test=false / contractor_is_test=true`, and every one of the
--   7 company names is visibly a test fixture (see the table below). The
--   profiles rows are wrong on the facts, not merely disagreeing with
--   contractors. So THIS migration repairs the other direction on these
--   specific rows: `profiles.is_test` is set to `true` to match reality.
--   This is the exception the rule permits, not a contradiction of it -- the
--   rule says profiles wins on which table to trust going forward; it does
--   not require accepting a demonstrably wrong profiles value on rows that
--   are already established test fixtures by every other signal (claims,
--   quotes, and contractors all agree these are test data -- see #1763's
--   R-173 re-read on claim 82f5dff4-5867-4b7a-88ca-942ce9bfe867).
--
-- Nothing is deleted (constitution entry 30). Only the flag is repaired.
--
-- THE 7 ROWS (profile_id | contractor_id | company_name), read 2026-09-08
-- via Supabase MCP execute_sql against production (yeszghaspzwwstvsrioa) --
-- the issue body's own disagreement query, BEFORE state (see pre-flight.md
-- for the full pasted output):
--
--   67da903b-ac48-4287-846c-0052583d5282 | 8fa0d121-d7e1-4064-8da3-c1bf6d83a4be | PFW Walk Roofing LLC
--   e371c617-8a24-492e-9911-47c85705ebb4 | 8e90ff23-3894-4f67-9ca7-58a044cd986b | Stohler Roofing, LLC
--   3ea4d929-b916-4cc9-a285-d052df397992 | ee452a12-c16e-4d30-9d2c-df8128fbce52 | Stohler Roofing, LLC
--   ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c | 848798cc-217c-44a5-83f3-c82b3c602452 | Video Walk Test Roofing LLC
--   92d669a8-c02a-42c1-9f52-53b7efd06ddf | 2bc792be-b677-4ac1-bc68-94b1561d9757 | Video Walk Test Roofing 2 LLC
--   eb7dace0-d26b-4a2f-adc3-7762459772c1 | 8f2ecbf8-8f41-4b05-a559-f1ed1f4ca746 | PFW Test Contractor
--   d4def812-aebc-444c-bdee-f68bccc19b61 | 986ce2b6-39fd-4a2c-aba4-a806c618c8c0 | PFW Roofing 1787836001
--
-- All 7 are profile_is_test=false / contractor_is_test=true, matching both
-- the issue body and the CTO's comment 5572645535 exactly.

begin;

-- Row-count assertion: refuses to run if production no longer matches the
-- pre-flight's 7-row baseline (a row already repaired by another path, an
-- id typo, or drift since 2026-09-08 would otherwise apply silently to the
-- wrong set). This is the count-guard analogue, for a targeted data UPDATE,
-- of migration-author-code's Step 6.5 rollback hard gate.
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
  and p.is_test = false;

  if v_count <> 7 then
    raise exception
      'gh-1763 REPAIR GUARD: expected exactly 7 profiles rows with is_test=false '
      'among the named ids, found %. Production has drifted since the 2026-09-08 '
      'pre-flight baseline -- STOP and re-read the disagreement query before '
      'proceeding.', v_count;
  end if;
end $$;

update public.profiles
set is_test = true
where id in (
  '67da903b-ac48-4287-846c-0052583d5282',
  'e371c617-8a24-492e-9911-47c85705ebb4',
  '3ea4d929-b916-4cc9-a285-d052df397992',
  'ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c',
  '92d669a8-c02a-42c1-9f52-53b7efd06ddf',
  'eb7dace0-d26b-4a2f-adc3-7762459772c1',
  'd4def812-aebc-444c-bdee-f68bccc19b61'
)
and is_test = false;

-- Post-condition (verify manually after apply -- not re-asserted here since
-- the UPDATE above is itself the fix and a second guard would just repeat
-- the pre-guard's logic against post-fix state):
--
--   select p.id as profile_id, p.is_test as profile_is_test,
--          c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
--   from public.profiles p join public.contractors c on c.user_id = p.id
--   where p.id in (<the 7 ids above>)
--   order by c.created_at;
--   -- expect: all 7 rows profile_is_test = true, contractor_is_test = true
--
-- And the issue's own disagreement query, scoped to these 7 (or run
-- unscoped for the full-table closes-on check):
--
--   select p.id as profile_id, p.is_test as profile_is_test,
--          c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
--   from public.profiles p join public.contractors c on c.user_id = p.id
--   where p.role = 'contractor' and p.is_test is distinct from c.is_test
--   order by c.created_at;
--   -- expect: 0 rows

commit;
