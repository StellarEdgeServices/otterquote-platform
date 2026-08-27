-- Rollback: v114_fix_bid_accepted_trigger_and_notify_rollback.sql
-- Reverts: v114_fix_bid_accepted_trigger_and_notify.sql
-- Author: Claude Code (automated, migration-author-code v1.1)
-- Date: 2026-08-26
--
-- WARNING: Restores the pre-gh-1293 behavior -- reintroduces the trigger
--          condition that can never be true (NEW.status = 'awarded'),
--          removes the contractor notification insert, and restores the
--          PUBLIC/anon/authenticated EXECUTE grants this function had
--          before the forward migration. Only run this if the forward
--          migration itself is the cause of a production incident.

BEGIN;

DROP TRIGGER IF EXISTS trg_log_bid_accepted ON public.quotes;
DROP FUNCTION IF EXISTS public.log_bid_accepted();

CREATE FUNCTION public.log_bid_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata, is_test)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price),
           COALESCE(NEW.is_test, false)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_log_bid_accepted
  AFTER UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION log_bid_accepted();

GRANT EXECUTE ON FUNCTION public.log_bid_accepted() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_bid_accepted() TO anon;
GRANT EXECUTE ON FUNCTION public.log_bid_accepted() TO authenticated;

COMMIT;
