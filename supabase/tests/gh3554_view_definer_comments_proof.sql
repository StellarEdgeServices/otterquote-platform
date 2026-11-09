-- gh-3554 proof: the COMMENT ON VIEW text lands, and the filter that stands in for RLS holds (closes-on control, comment 6728491662).
-- DRAFT, NOT RUN. Written without database access. exec:cto runs it against production (yeszghaspzwwstvsrioa) as ONE transaction that ends in ROLLBACK.
-- Nothing commits: the forward comments are applied inside the transaction, read back, and rolled back with everything else.
-- Subjects are is_test rows only, looked up by the id prefixes recorded in comment 6728485033 (no full uuids are held in the repo):
--   contractor 2bc792be (active, is_test), claim 82f5dff4 (bid + selected: >0 rows), claim 4d764e19 (selected to another contractor, not bid: 0 rows),
--   claim 6aea8081 (contract_signed, not bid: 0 rows for bidder_claim_summary).
-- If a prefix does not resolve to exactly one row the check block raises and the transaction aborts: nothing is silently skipped.
-- To run: strip the BEGIN/COMMIT from gh3554_view_definer_comments.sql and paste its two COMMENT statements at the marker below.
-- The last statement before ROLLBACK is the result table; every row's ok must be true.

BEGIN;

CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, label text, got text, expected text, ok boolean);

CREATE TEMP TABLE subj AS
SELECT ct.id AS contractor_id, ct.user_id,
       (SELECT c.id FROM public.claims c WHERE c.id::text LIKE '82f5dff4%' AND c.is_test) AS own_claim,
       (SELECT c.id FROM public.claims c WHERE c.id::text LIKE '4d764e19%' AND c.is_test) AS other_claim,
       (SELECT c.id FROM public.claims c WHERE c.id::text LIKE '6aea8081%' AND c.is_test) AS signed_claim
FROM public.contractors ct
WHERE ct.id::text LIKE '2bc792be%' AND ct.is_test AND ct.status = 'active';

DO $chk$
BEGIN
  IF (SELECT count(*) FROM subj) <> 1 OR (SELECT own_claim FROM subj) IS NULL
     OR (SELECT other_claim FROM subj) IS NULL OR (SELECT signed_claim FROM subj) IS NULL THEN
    RAISE EXCEPTION 'gh3554 proof: subject lookup did not resolve to exactly one contractor and three is_test claims';
  END IF;
END $chk$;

-- Phase A: apply the forward comments inside this transaction.
-- >>> PASTE THE TWO COMMENT ON VIEW STATEMENTS FROM gh3554_view_definer_comments.sql HERE <<<

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'obj_description bidder_claim_summary names definer + auth.uid() filter',
       (position('SECURITY DEFINER' in d) > 0 AND position('auth.uid()' in d) > 0)::text, 'true',
       (position('SECURITY DEFINER' in d) > 0 AND position('auth.uid()' in d) > 0)
FROM (SELECT obj_description('public.bidder_claim_summary'::regclass, 'pg_class') AS d) x;

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'obj_description contractor_thread_messages names definer + auth.uid() filter',
       (position('SECURITY DEFINER' in d) > 0 AND position('auth.uid()' in d) > 0)::text, 'true',
       (position('SECURITY DEFINER' in d) > 0 AND position('auth.uid()' in d) > 0)
FROM (SELECT obj_description('public.contractor_thread_messages'::regclass, 'pg_class') AS d) x;

-- The temp tables are owned by the session role; the authenticated role needs rights on them (they vanish with the transaction).
GRANT ALL ON pg_temp.subj, pg_temp.proof_r TO authenticated;
GRANT ALL ON SEQUENCE pg_temp.proof_r_n_seq TO authenticated;

-- Phase B: reads as the active is_test contractor (role authenticated, jwt sub = the contractor's user_id).
SELECT set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true) FROM subj;
SET LOCAL ROLE authenticated;

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'bcs: NON-open claim (contract_signed) the contractor has not bid on -> 0 rows (control)',
       count(*)::text, '0', count(*) = 0
FROM public.bidder_claim_summary v WHERE v.id = (SELECT signed_claim FROM pg_temp.subj);

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'bcs: claim selected to another contractor, not bid -> 0 rows (control)',
       count(*)::text, '0', count(*) = 0
FROM public.bidder_claim_summary v WHERE v.id = (SELECT other_claim FROM pg_temp.subj);

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'bcs: own selected claim -> >0 rows',
       count(*)::text, '>0', count(*) > 0
FROM public.bidder_claim_summary v WHERE v.id = (SELECT own_claim FROM pg_temp.subj);

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'ctm: claim where the contractor is NOT the selected one -> 0 rows (control)',
       count(*)::text, '0', count(*) = 0
FROM public.contractor_thread_messages v WHERE v.claim_id = (SELECT other_claim FROM pg_temp.subj);

INSERT INTO proof_r(label, got, expected, ok)
SELECT 'ctm: own selected claim -> >0 rows',
       count(*)::text, '>0', count(*) > 0
FROM public.contractor_thread_messages v WHERE v.claim_id = (SELECT own_claim FROM pg_temp.subj);

RESET ROLE;

SELECT n, label, got, expected, ok FROM proof_r ORDER BY n;

ROLLBACK;
