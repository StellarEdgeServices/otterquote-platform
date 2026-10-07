-- Rollback for 20261005210000_gh2491_message_counterpart.sql (gh-2491).
-- Drops the function only; no table, policy or data is touched by the forward file.
-- The dashboards fall back to the literal "the homeowner" (contractor view) and
-- "your contractor" (homeowner view) when the rpc is absent, so this is safe at any time.
BEGIN;
DROP FUNCTION IF EXISTS public.get_message_counterpart(uuid);
COMMIT;
