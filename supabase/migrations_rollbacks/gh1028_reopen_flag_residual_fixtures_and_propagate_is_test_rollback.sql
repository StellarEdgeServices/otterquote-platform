-- Rollback for: 20260818225000_gh1028_reopen_flag_residual_fixtures_and_propagate_is_test.sql
-- GitHub: #1028
--
-- The quotes.is_test backfill in the forward migration is not destructively
-- reversible in a stable way (the original 2 rows are indistinguishable from
-- other true rows purely by is_test state), so this rollback restores the
-- specific 2 known rows by id rather than by re-deriving the predicate, and
-- reverts the trigger functions to their pre-migration bodies (no is_test
-- propagation). No data is destroyed either direction.

BEGIN;

UPDATE public.quotes
   SET is_test = false
 WHERE id IN ('ca91add4-1019-49d5-9682-2e8ebe1e0c3c', 'e6261cb3-1132-4ce4-bb31-4231f3a801c7');

CREATE OR REPLACE FUNCTION public.log_bid_submitted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN INSERT INTO activity_log (user_id, event_type, title, metadata) SELECT ct.user_id, 'bid_submitted', 'Bid submitted for ' || COALESCE(c.property_address, 'a project'), jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price) FROM claims c JOIN contractors ct ON ct.id = NEW.contractor_id WHERE c.id = NEW.claim_id; RETURN NEW; EXCEPTION WHEN OTHERS THEN RAISE WARNING 'log_bid_submitted trigger error: %', SQLERRM; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.log_bid_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
