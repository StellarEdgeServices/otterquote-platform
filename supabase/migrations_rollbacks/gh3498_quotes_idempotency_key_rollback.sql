-- STATUS: DRAFT forward file is NOT applied; this rollback is NOT run.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3498_quotes_idempotency_key. Drops the index, then the column. The only data lost is the key values themselves;
-- no bid row is touched. After this the forms' PGRST204 fallback files bids without a key, as before.
BEGIN;

DROP INDEX IF EXISTS public.quotes_idempotency_key_uidx;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS idempotency_key;

COMMIT;
