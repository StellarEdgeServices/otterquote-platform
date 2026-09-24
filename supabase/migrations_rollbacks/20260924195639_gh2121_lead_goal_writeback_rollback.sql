-- Rollback for supabase/migrations/20260924195639_gh2121_lead_goal_writeback.sql
-- (gh-2121, LRS HO-1 S16).
--
-- Drops only what that file adds: the view, the RPC, and its grants. Does
-- NOT null out any leads.converted_user_id value the RPC has since written
-- -- those are real attribution data (marketing history), not schema, and
-- rolling back the code path that writes new ones should not destroy rows
-- already correctly linked. converted_user_id itself is NOT dropped here
-- either: it is 20260916132127's column, not this migration's, and this
-- migration only ever wrote to it.

BEGIN;

DROP VIEW IF EXISTS public.lead_goal_events;

REVOKE ALL ON FUNCTION public.set_lead_converted(uuid, uuid) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.set_lead_converted(uuid, uuid);

COMMIT;
