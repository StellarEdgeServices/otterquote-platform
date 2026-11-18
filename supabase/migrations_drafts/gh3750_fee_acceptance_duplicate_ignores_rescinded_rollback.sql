-- gh-3750 ROLLBACK: remove ` AND d.rescinded_at IS NULL` from the guard's duplicate rule. Idempotent. DRAFT FILE ONLY, never applied.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rb$
DECLARE
  src text;
  new_frag constant text := 'WHERE d.bid_id = NEW.bid_id AND d.rescinded_at IS NULL';
  old_frag constant text := 'WHERE d.bid_id = NEW.bid_id';
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = to_regprocedure('public.fee_acceptances_guard_client_insert()');
  IF src IS NULL THEN RAISE EXCEPTION 'gh3750 rollback: guard function missing'; END IF;
  IF position(new_frag IN src) = 0 THEN RAISE NOTICE 'gh3750 rollback: condition not present; nothing to do'; RETURN; END IF;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.fee_acceptances_guard_client_insert() RETURNS trigger LANGUAGE plpgsql SET search_path TO ''public'', ''pg_temp'' AS '
          || quote_literal(replace(src, new_frag, old_frag));
END
$rb$;
COMMIT;
