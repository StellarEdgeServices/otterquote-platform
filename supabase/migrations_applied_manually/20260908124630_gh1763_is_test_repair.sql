-- gh-1763: repair profiles.is_test on 7 rows where profiles.is_test and
-- contractors.is_test disagree.
--
-- >>> APPLIED MANUALLY (not a draft, not a db-push replay file) <<<
-- DECIDED (Tier A) by Marty, CTO RUN 42, PR #2233 comment 5850353019,
-- 2026-09-26T22:12:20Z, quoted verbatim: "the gh1763 data-repair was
-- APPLIED on 2026-09-08 (CTO comment 5585368997 on #1763: run verbatim via
-- execute_sql, guard passed, disagreement count 7 -> 0). Move it UNCHANGED,
-- guard included, to supabase/migrations_applied_manually/20260908124630_gh1763_is_test_repair.sql
-- with a header: 'Applied manually 2026-09-08 via execute_sql (see #1763
-- comment 5585368997). NEVER replay. No schema_migrations row by design.'
-- Keep the guard -- on an accidental re-run it matches 0 rows and raises,
-- which is the safe failure. Rejected alternatives: (a) add a
-- schema_migrations row (a production ledger write that would demand a
-- replay file whose guard raises on every fresh branch); (b) strip the
-- guard (removes the only protection against a re-run)." This file's
-- location, filename and guard already matched that ruling before it was
-- posted (this branch moved it here per the independent reviewer's
-- recommendation, comment 5850286498); this header cites the ruling
-- verbatim per the coordinator's follow-up instruction so the file's own
-- text, not only the PR/issue comments, carries the DECIDED citation.
--
-- This file ran, byte-identical to below (guard included), against
-- production (yeszghaspzwwstvsrioa) on 2026-09-08 at approximately
-- 12:46:30Z UTC, executed by Marty (CTO) via Supabase MCP execute_sql --
-- NOT via `supabase db push` and NOT recorded in
-- supabase_migrations.schema_migrations (that table has no row for this
-- file or for any statement naming the 7 ids below; execute_sql does not
-- write to it). Full evidence, before/after state and three negative
-- controls: issue #1763, comment 5585368997 ("## DONE (evidence) -- the
-- repair is APPLIED to production. Disagreement query returns 0 rows."),
-- section 5 ("THE APPLY"): guard passed (found exactly 7 matching rows,
-- did not raise), UPDATE ran, disagreement count went 7 -> 0.
--
-- THIS FILE MUST NEVER BE:
--   - moved into supabase/migrations/ (the CLI replays that directory
--     forward onto every fresh branch; the guard below finds 0 of 7
--     matching rows on an empty database and RAISEs, blocking every
--     migration after it in the chain);
--   - given a supabase_migrations.schema_migrations row (that would tell
--     the replay chain a file is expected here, recreating the same
--     hazard from the other direction);
--   - stripped of its row-count guard (the guard is what makes an
--     accidental future re-run of this file a safe no-op instead of a
--     silent second UPDATE -- on current production it finds 0 of 7 rows
--     with is_test=false and raises, doing nothing).
--
-- Relocated here 2026-09-26 from supabase/migrations_drafts/ (gh-1438,
-- REVIEW FAIL 5850286498; confirmed by DECIDED ruling 5850353019) --
-- that directory's own definition (supabase/migrations/README.md) is
-- "SQL that was written but is NOT applied in production", which this
-- file has not been true of since 2026-09-08. Content below is unchanged
-- from what actually ran; only this header and the file's location
-- changed. Rollback and pre-flight docs, unmoved:
-- supabase/migrations_rollbacks/gh1763_is_test_repair_rollback.sql
-- and supabase/migrations_rollbacks/gh1763_is_test_repair_pre-flight.md
-- (if present).
--
-- Current unscoped state (re-checked 2026-09-26, read-only, this session):
--   select p.id, p.is_test, c.id, c.is_test, c.company_name, c.created_at
--   from public.profiles p join public.contractors c on c.user_id = p.id
--   where p.role = 'contractor' and p.is_test is distinct from c.is_test;
--   -> 1 row: profile f70fe577-549d-47cc-88d0-dac90fc010b9 (is_test=true) /
--      contractor (is_test=false), "Ceo48 GH2000 Test Co", created
--      2026-09-16 -- the REVERSE direction from this file's 7 rows, a
--      different contractor entirely, created after this repair ran.
--      Issue #1763 is closed not_planned (comment 5763651883); this
--      row is not this file's concern and this file does not touch it.
--
-- TIER NOTE (superseded -- kept for history): issue #1763 carried label
-- tier:3a; a Kevin (Code lane) dispatch on this thread had recommended
-- moving it to Tier 3B. Marty (CTO) ruling, comment 5585368997
-- (2026-09-08T12:46:30Z): stays Tier 3A -- R-097's 24-hour window applies
-- only where rollback is impossible, and this UPDATE's rollback is
-- "merged, count-guarded and byte-readable" (the sibling rollback file).
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
-- of migration-author-code's Step 6.5 rollback hard gate. LEFT IN PLACE --
-- see "THIS FILE MUST NEVER BE" above -- this is what makes a re-run safe.
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

-- Post-condition (verified 2026-09-08 -- see comment 5585368997 section 6
-- for the full before/after plus negative controls A-F):
--
--   select p.id as profile_id, p.is_test as profile_is_test,
--          c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
--   from public.profiles p join public.contractors c on c.user_id = p.id
--   where p.id in (<the 7 ids above>)
--   order by c.created_at;
--   -- confirmed 2026-09-08: all 7 rows profile_is_test = true, contractor_is_test = true
--   -- re-confirmed read-only 2026-09-26 (this session): unchanged
--
-- And the issue's own disagreement query, scoped to these 7 (confirmed 0
-- rows 2026-09-08; the unscoped, full-table version is re-run and recorded
-- fresh above under "Current unscoped state" -- it returns 1 row today, and
-- that row is not these 7):
--
--   select p.id as profile_id, p.is_test as profile_is_test,
--          c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
--   from public.profiles p join public.contractors c on c.user_id = p.id
--   where p.role = 'contractor' and p.is_test is distinct from c.is_test
--     and p.id in (<the 7 ids above>)
--   order by c.created_at;
--   -- expect: 0 rows

commit;
