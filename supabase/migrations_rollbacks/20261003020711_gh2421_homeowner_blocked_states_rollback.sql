-- Rollback for 20261003010000_gh2421_homeowner_blocked_states.sql (gh-2421 / D-344).
-- Drops the read function and deletes the seeded row. Clients fall back to the
-- hard-coded {FL,LA,TX} list when the rpc is absent, so this is safe at any time.
BEGIN;
DROP FUNCTION IF EXISTS public.get_homeowner_blocked_states();
DELETE FROM public.platform_settings WHERE key = 'homeowner_blocked_states';
COMMIT;
