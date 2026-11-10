-- STATUS: DRAFT -- NOT APPLIED. Tier 3A additive, applied only under the Tier 3B path (migration-author, review, R-097 notice, a recorded apply).
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
