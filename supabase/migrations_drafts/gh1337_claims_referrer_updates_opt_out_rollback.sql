-- STATUS (gh-1438, as of 2026-09-30T12:32Z): APPLIED
-- FILE ROLE: rollback file of set gh1337_claims_referrer_updates_opt_out (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: claims.referrer_updates_opt_out live, ledger version 20260831124504; applied text is a condensed rewrite, NOT byte-identical to this draft: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260831124504 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: supabase/migrations_rollbacks/20260831124504_gh1337_claims_referrer_updates_opt_out_rollback.sql -- same SQL statements (differs only in comments/blank lines/BEGIN/COMMIT/whitespace)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> COMPANION OF AN APPLIED MIGRATION (2026-09-26, gh-1438 part 2) -- the
-- forward migration this rollback reverses is live in production, filed as
-- supabase/migrations/20260831124504_gh1337_claims_referrer_updates_opt_out.sql.
-- This rollback itself was never run. Kept here, unmodified below this
-- banner, for history and for future use if the column ever needs to be
-- reverted. <<<
-- gh-1337 rollback.sql — reverses gh1337_claims_referrer_updates_opt_out_forward.sql
--
-- STATUS: DRAFT ONLY, paired with a forward migration that has NOT been applied.
--
-- DATA LOSS WARNING: dropping this column destroys every homeowner consent
-- choice captured since the forward migration ran. That is a consent record,
-- not derived data — it cannot be reconstructed from anything else in the
-- schema. Before running this, export it:
--
--   SELECT id, referrer_updates_opt_out, created_at
--     FROM public.claims
--    WHERE referrer_updates_opt_out IS NOT NULL;
--
-- Behaviour after rollback: the consent gate in send-partner-status-email is
-- written to tolerate the column's absence — the claims lookup errors, the gate
-- logs a warning, falls back to referrals.metadata.referrer_updates_opt_out,
-- and, finding nothing, fails closed. Net effect: no third-party
-- claim-progress emails send at all. That is safe, not broken. Roll back the
-- Edge Function too if sends must resume.

BEGIN;

ALTER TABLE public.claims
  DROP COLUMN IF EXISTS referrer_updates_opt_out;

COMMIT;
