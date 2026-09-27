-- gh-1028: additive is_test column on activity_log, Tier 3A, Dustin-approved 2026-08-18.
-- CORRECTED 2026-09-26 (gh-1438 part 2): this file was previously filed at
-- version 20260818204945; the real ledger row is 20260818205120 (confirmed
-- read-only this session). Content below unchanged.
-- Same pattern as v104 (20260810233131_v104_add_is_test_to_quotes_and_referral_ledger.sql):
-- Same pattern as v104 (20260810232816_v104_add_is_test_to_quotes_and_referral_ledger.sql):
-- NOT NULL DEFAULT false is a fast metadata-only add on Postgres 11+ (no table rewrite),
-- so this does not need the nullable-then-backfill two-step the issue's AC1 text was
-- guarding against on the (mistaken, pre-Postgres-11) assumption that a defaulted
-- ADD COLUMN rewrites the table. Backfill for the specific harness rows is a separate,
-- targeted UPDATE — see sql/2026-08-18-flag-harness-bids-1028.sql — not a table-wide
-- backfill statement.

ALTER TABLE public.activity_log
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
