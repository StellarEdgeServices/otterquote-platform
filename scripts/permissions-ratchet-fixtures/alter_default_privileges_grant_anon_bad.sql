-- RATCHET-FIXTURE: EXPECT=FAIL
-- PR #1836 comment 5578401122, probe (f) -- a fully static, non-dynamic
-- ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon; statement defeats the old
-- rule 1 entirely because GRANT_RE was anchored to statement-start
-- (`^\s*GRANT\b`) and this statement starts with ALTER, not GRANT. Rule 1
-- must be unanchored: any statement that is not REVOKE-shaped and contains
-- GRANT ... TO <disallowed-role> anywhere fails, regardless of prefix.
BEGIN;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;

COMMIT;
