-- STATUS: DRAFT forward file is NOT applied; this rollback is NOT run.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3848_quotes_manual_bid_unique. Drops the index only; no bid row is touched. After this a reload retry can file a
-- second bid again (the #3498 same-page protection stays).
BEGIN;

DROP INDEX IF EXISTS public.quotes_manual_bid_uidx;

COMMIT;
