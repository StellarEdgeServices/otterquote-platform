-- RATCHET-FIXTURE: EXPECT=FAIL
-- PR #1836 comment 5578401122, probe (a) -- the confirmed evasion: the role
-- name lives in a SEPARATE string literal, joined to the GRANT...TO literal
-- by `||`, immediately after the `TO ` boundary. As two independently
-- scanned spans this produced NO finding at all (the first span's roles
-- capture matched only the trailing whitespace before its closing quote,
-- yielding an empty role list that was silently treated as a pass). Rule 4
-- must merge string literals joined end-to-end by `||` into one logical
-- string before scanning.
BEGIN;

EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO ' || 'anon';

COMMIT;
