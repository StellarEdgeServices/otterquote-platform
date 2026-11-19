-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (forward, ledger version 20261110201420); this rollback is NOT run
-- FILE ROLE: rollback file of set gh3560_renew_quote_rpc (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-09 under #3560 (CTO ruling, comment 6740503022). No database write was made to produce this file; see the forward file for the read-only production facts.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3560_renew_quote_rpc_rollback.sql
-- Reverts: gh3560_renew_quote_rpc.sql
-- GitHub: #3560
--
-- Drops the function. Nothing in the database depends on it. Roll the two bid-form pages back FIRST (or together): once the
-- function is gone, a page that calls it for Renew Bid / Change Bid on a withdrawn bid gets an error and the save stops (the
-- pre-change pages failed the same save with 42501, so a rollback returns to that state, no worse).
BEGIN;

DROP FUNCTION IF EXISTS public.renew_quote(uuid, text);

COMMIT;
