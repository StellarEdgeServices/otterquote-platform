-- gh-1544: partial unique index on lower(email) for contractors, guarding
-- against duplicate contractor applications for the same email address.
-- Server-side backstop for the app-layer gates shipped in PR #1557
-- (check-email-exists, called before insert on contractor-join.html and
-- contractor-pre-approval.html) -- it closes the race where two signups for
-- the same email land concurrently between the check and the insert.
--
-- Approved by CTO run cto-2026-09-02T23:39:49Z (issue comment 5518184628,
-- 2026-09-02T23:57:30Z): Tier 3A (additive index, D-261/R-097) -- autonomous,
-- no 24h notice window required.
--
-- Live enumeration re-run by the CTO at 2026-09-02T23:58Z confirms the index
-- applies cleanly today:
--   total_rows=13, non_test_rows=0, null_emails=0, nontest_dup_groups=0,
--   all_dup_groups=1 (the single Stohler Roofing pair, both is_test=true,
--   excluded by the partial predicate), is_test_nullable=0 (contractors.is_test
--   is NOT NULL, so `is_test = false` is exactly equivalent to
--   `is_test is not true` -- no three-valued-logic hole).
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- file intentionally carries no BEGIN/COMMIT wrapper and must stay the only
-- statement in its migration file (migration-author-code skill convention).
-- On failure CONCURRENTLY leaves an INVALID index behind rather than rolling
-- back automatically -- see the rollback file's note before retrying.
--
-- Condition attached by the CTO ruling (same comment, section 3): the
-- insert paths must catch SQLSTATE 23505 on this index and render the
-- existing "Application Already Exists" panel rather than a raw Postgres
-- error, since checkEmailExists() fails open on lookup error. That handler
-- ships in this same PR (contractor-pre-approval.html) -- both land together
-- per the CTO's hard condition.
--
-- Rollback: 20260903184350_gh1544_contractors_email_lower_uniq_rollback.sql
-- Pre-flight: 20260903184350_gh1544_contractors_email_lower_uniq_pre-flight.md

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS contractors_email_lower_uniq
  ON contractors (lower(email))
  WHERE is_test = false;
