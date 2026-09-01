-- gh-1304 (v115): guard log_bid_accepted() so a logging failure can't abort
-- bid acceptance. Swallow-with-record per the binding design in issue
-- comment 5483400570 (2026-08-31T19:28:44Z) -- RAISE WARNING, never a bare
-- swallow. Body is otherwise byte-identical to the pre-image read from
-- production (pg_proc.prosrc) on 2026-09-01; only an EXCEPTION clause is
-- added to the function's existing top-level BEGIN...END block.
--
-- All other properties preserved exactly from the live definition, and
-- re-verified after apply:
--   LANGUAGE plpgsql, SECURITY DEFINER, SET search_path TO 'public', 'pg_temp'.
-- The search_path pin is load-bearing: this database carries a
-- fix_security_definer_search_paths migration in its history precisely because
-- a CREATE OR REPLACE once dropped one.
--
-- Proven before apply: forward AND rollback halves executed against production
-- inside one BEGIN ... ROLLBACK, with the guard observed catching a real
-- failure (postgres_logs carried its own RAISE WARNING with SQLSTATE 23514),
-- then production re-read and confirmed unchanged.
--
-- R-097 Tier 3B window opened 2026-08-31T13:32:10Z, closed 2026-09-01T13:27:39Z
-- with no objection. Applied by CTO run cto-2026-09-01T12:04:56Z at 13:27:54Z.
-- Rollback: 20260901132754_gh1304_v115_guard_log_bid_accepted_rollback.sql
CREATE OR REPLACE FUNCTION public.log_bid_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- gh-1293: was NEW.status = 'awarded'; the app writes 'selected'.
  IF NEW.status = 'selected' AND (OLD.status IS NULL OR OLD.status IS DISTINCT FROM 'selected') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata, is_test)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price),
           COALESCE(NEW.is_test, false)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;

    INSERT INTO notifications (user_id, claim_id, notification_type, channel, recipient, message_preview)
    SELECT ct.user_id,
           NEW.claim_id,
           'bid_accepted',
           'dashboard',
           '',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project') ||
             '. Sign the contract in your dashboard to get started.'
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'log_bid_accepted failed for bid %: % (%)', NEW.id, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$function$;
