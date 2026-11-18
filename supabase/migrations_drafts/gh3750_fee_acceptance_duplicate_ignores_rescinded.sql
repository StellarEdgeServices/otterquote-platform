-- gh-3750: let a REOPENED (withdrawn then re-bid) bid record a fresh fee acceptance.
-- STATUS (as of 2026-11-15): NOT APPLIED. DRAFT FILE ONLY. Tier 3B (money path, consent record, D-214 / D-215): REVIEW, R-177 pair naming D-215, R-097 24-hour notice, a recorded apply.
-- DO NOT RUN FROM THIS DIRECTORY (see supabase/migrations_drafts/README.md). Rollback: gh3750_fee_acceptance_duplicate_ignores_rescinded_rollback.sql
-- EVIDENCE: production read-only SELECT 2026-11-15 (project yeszghaspzwwstvsrioa): public.fee_acceptances_guard_client_insert() is the gh3409 body; its duplicate rule is
--   IF EXISTS (SELECT 1 FROM public.fee_acceptances d WHERE d.bid_id = NEW.bid_id) THEN ... 'duplicate_bid'   (gh3490 is NOT applied).
-- WHY: PR #3752 makes rescind-bid stamp fee_acceptances.rescinded_at. A withdrawn bid can be reopened on the SAME quote id (renew_quote 'reopen'), and the contract-bid forms now write a
--   fresh acceptance row on that path (D-214: submission is the act of acceptance). With the rule above that fresh row would be diverted to quarantine (duplicate_bid) because the stamped
--   row still exists. This file changes the duplicate rule to ignore rescinded rows: a row that was rescinded no longer counts as "the acceptance on file".
-- What changes: ONE condition, ` AND d.rescinded_at IS NULL`, appended to the duplicate rule's WHERE. Nothing else in the body, owner, ACL, search_path or trigger. It is applied as a textual
--   replace of the LIVE body, so it composes with gh3490 whichever is applied first (gh3490 keeps its extra fee condition after `d.bid_id = NEW.bid_id`; this adds one more AND).
-- What it does NOT do: change any wording; let a client set rescinded_at (the guard still forces NEW.rescinded_at := NULL on every client insert); touch any row.
-- SEQUENCING: if gh3490 is applied later, its pre-check (prosrc md5 1142fe98) will refuse the body this file produces; re-render gh3490 against it, or apply gh3490 first.
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE (psql -v ON_ERROR_STOP=1 -f). Never wrap it in BEGIN ... ROLLBACK.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  src text;
  old_frag constant text := 'WHERE d.bid_id = NEW.bid_id';
  new_frag constant text := 'WHERE d.bid_id = NEW.bid_id AND d.rescinded_at IS NULL';
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = to_regprocedure('public.fee_acceptances_guard_client_insert()');
  IF src IS NULL THEN RAISE EXCEPTION 'gh3750: public.fee_acceptances_guard_client_insert() does not exist; gh3409 must be applied first'; END IF;
  IF position(new_frag IN src) > 0 THEN RAISE NOTICE 'gh3750: already applied; nothing to do'; RETURN; END IF;
  IF (length(src) - length(replace(src, old_frag, ''))) / length(old_frag) <> 1 THEN
    RAISE EXCEPTION 'gh3750: the duplicate rule fragment is not present exactly once in the live body; refusing';
  END IF;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.fee_acceptances_guard_client_insert() RETURNS trigger LANGUAGE plpgsql SET search_path TO ''public'', ''pg_temp'' AS '
          || quote_literal(replace(src, old_frag, new_frag));
END
$mig$;

-- GUARD: the live body now carries the condition exactly once.
DO $g$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = to_regprocedure('public.fee_acceptances_guard_client_insert()');
  IF position('d.bid_id = NEW.bid_id AND d.rescinded_at IS NULL' IN src) = 0 THEN
    RAISE EXCEPTION 'gh3750: the guard body does not carry the rescinded_at condition after the change';
  END IF;
END
$g$;
COMMIT;
