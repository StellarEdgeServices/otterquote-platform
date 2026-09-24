-- Rollback for supabase/migrations/20260924195639_gh2121_lead_goal_writeback.sql
-- (gh-2121, LRS HO-1 S16).
--
-- Updated 2026-09-24 (PR #2163 REVIEW: FAIL fix, comment 5821864061, S1):
-- the forward migration now DROPs the original two-arg
-- set_lead_converted(uuid, uuid) itself and replaces it with the one-arg
-- set_lead_converted(uuid) (auth.uid()-derived, S1). This rollback targets
-- the CURRENT (one-arg) signature; it also still drops the two-arg
-- signature IF EXISTS, so it stays a correct rollback whether applied
-- against a database that ran the very first draft of the forward file (a
-- signature that never reached production -- this migration was never
-- applied per Supabase SELECT-only, per its own header) or the current one.
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

REVOKE ALL ON FUNCTION public.set_lead_converted(uuid) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.set_lead_converted(uuid);

-- Belt and suspenders: also drop the never-applied two-arg signature from
-- this PR's first draft, in case a rollback runs against a database that
-- somehow only ever saw that version.
DROP FUNCTION IF EXISTS public.set_lead_converted(uuid, uuid);

COMMIT;
