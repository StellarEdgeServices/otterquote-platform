-- RATCHET-FIXTURE: EXPECT=FAIL
-- PR #1836 comment 5578401122, probe (e) -- the split point falls BEFORE
-- the `TO` keyword instead of after it. Under the old code this happened to
-- be caught only when the whole thing sat inside a single `$$...$$` span
-- (the reviewer's own root-cause note: "a coincidence of where the string
-- boundary falls relative to the keyword, not a deliberate concatenation-
-- aware scan"). This fixture is the same split at bare top-level EXECUTE,
-- two separate single-quoted literals -- must fail by the same explicit
-- `||`-merge logic as the after-TO split, not by accident.
BEGIN;

EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() ' || 'TO anon';

COMMIT;
