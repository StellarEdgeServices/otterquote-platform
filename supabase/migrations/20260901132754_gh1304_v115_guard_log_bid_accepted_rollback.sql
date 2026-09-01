-- ROLLBACK for 20260901132754_gh1304_v115_guard_log_bid_accepted.sql
--
-- Restores log_bid_accepted() to the definition read from production
-- (pg_proc.prosrc) immediately before the forward half was applied on
-- 2026-09-01. Proven in the same BEGIN ... ROLLBACK transaction as the forward
-- half: after running this, prosrc/prosecdef/provolatile/proconfig were all
-- byte-identical to the pre-image.
--
-- What reverting costs you, stated so the decision is informed: without the
-- EXCEPTION clause, ANY failure of the two INSERTs below aborts the whole
-- transaction -- and the only trigger bound to this function is
-- trg_log_bid_accepted AFTER UPDATE ON quotes, which every bid acceptance
-- passes through, including v116's accept_bid() RPC. Reverting restores a state
-- in which a logging failure kills a money-path transaction. That is the hazard
-- gh-1304 exists to remove.
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
END;
$function$;
