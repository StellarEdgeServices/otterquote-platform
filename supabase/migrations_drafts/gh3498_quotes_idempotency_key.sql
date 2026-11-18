-- STATUS (gh-1438, as of 2026-11-18T19:59:38Z): APPLIED (ledger version 20261118193824, name gh3498_quotes_idempotency_key; the lines below are the pre-apply drafting record)
-- FILE ROLE: forward file of set gh3498_quotes_idempotency_key (rollback and pre-flight are in supabase/migrations_rollbacks/)
-- EVIDENCE: applied to production 2026-11-18 on Dustin's chat word "Go A-H." (14:30 ET) by Ben, CEO RUN 155 (claim ceo-2026-11-18T18:18:18Z): issue #3498 comment 6989532456 (APPLIED; sha256 b285a0eecfe6761e... MATCH; column quotes.idempotency_key and index quotes_idempotency_key_uidx present). Read-only SELECT of supabase_migrations.schema_migrations, project yeszghaspzwwstvsrioa: statements[1] is 1452 bytes, md5 0458604b2f208a21..., equal to this file as it was when applied (before this header edit).
-- REPO COPY: supabase/migrations/20261118193824_gh3498_quotes_idempotency_key.sql (byte-identical to the SQL that ran, with its old DRAFT header; the filed copy is the record, do not run this draft again). Rollback and pre-flight stay in supabase/migrations_rollbacks/ unchanged.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3498_quotes_idempotency_key
-- GitHub: #3498 (REVIEW 6675274132 on PR #3491). Rollback: supabase/migrations_rollbacks/gh3498_quotes_idempotency_key_rollback.sql
--
-- What changes: one nullable column and one partial unique index on public.quotes. Both bid forms send a client-generated
-- key with a new bid. If an insert times out after it landed, the retry carries the same key, fails with SQLSTATE 23505 on
-- quotes_idempotency_key_uidx, and the form reads the existing row back as the result instead of filing a second bid.
-- Existing rows keep NULL and rows without a key (auto-bids, admin writes, old clients) are outside the index.
-- The key is written only on INSERT; no UPDATE path touches it.
-- Until this is applied the forms detect the unknown column (PGRST204) and file the bid as before.
BEGIN;

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_idempotency_key_uidx
  ON public.quotes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.quotes.idempotency_key IS
'gh-3498: client-generated key for one bid being filed, reused by retries of that bid. NULL for bids filed without one.';

COMMIT;
