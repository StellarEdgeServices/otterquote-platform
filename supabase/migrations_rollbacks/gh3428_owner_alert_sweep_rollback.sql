-- gh-3428 ROLLBACK. Run manually only if the gh-3428 change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- Section 1 stops the sweep (run it first, alone, if all you need is to stop calls). Section 2 removes the schema and DELETES the owner_alerts rows (the call log; nothing else reads them).
-- Touches no hover_orders, claims, quotes or profiles row.

-- Section 1: stop the schedule.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gh3428-owner-alert-sweep') THEN
    PERFORM cron.unschedule('gh3428-owner-alert-sweep');
  END IF;
END $$;
COMMIT;

-- Section 2: remove the functions and the table.
BEGIN;
DROP FUNCTION IF EXISTS public.owner_alert_mark(uuid, boolean, text, text, integer);
DROP FUNCTION IF EXISTS public.owner_alert_claim_batch(integer, interval, interval, integer);
DROP FUNCTION IF EXISTS public.owner_alert_is_internal(uuid);
DROP TABLE IF EXISTS public.owner_alerts;
COMMIT;
