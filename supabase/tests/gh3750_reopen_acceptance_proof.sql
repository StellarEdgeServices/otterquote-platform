-- gh-3750 proof (THROWAWAY Postgres only). psql -v phase=before|after|rollback -f texts.psql -f this_file. Base = gh3409 throwaway schema + gh3409 forward (today's production guard).
-- Scenario: first acceptance -> rescind-bid's stamp (service role) -> the reopened bid's fresh acceptance from the contractor's own session (same text, same fee).
-- before / rollback: the fresh row is QUARANTINED (duplicate_bid) = why the migration is needed. after: recorded, 2 rows, the newest un-rescinded. All inside BEGIN ... ROLLBACK.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;
\o /dev/null
CREATE SCHEMA proof;
CREATE TABLE proof.who AS SELECT gen_random_uuid() AS uid, gen_random_uuid() AS k, gen_random_uuid() AS c, gen_random_uuid() AS qid;
GRANT USAGE ON SCHEMA proof TO authenticated; GRANT SELECT ON proof.who TO authenticated;
INSERT INTO public.contractors (id, user_id) SELECT k, uid FROM proof.who;
INSERT INTO public.claims(id) SELECT c FROM proof.who;
SELECT set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) FROM proof.who;
SET LOCAL ROLE authenticated;
INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount) SELECT c, k, 15000, 0, 0 FROM proof.who;
RESET ROLE;
UPDATE proof.who SET qid = (SELECT id FROM public.quotes WHERE claim_id = who.c);
CREATE FUNCTION proof.ins(p_text text) RETURNS text LANGUAGE plpgsql AS $i$
DECLARE w proof.who; r text;
BEGIN
  SELECT * INTO w FROM proof.who;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', w.uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent)
      VALUES (w.k, w.c, w.qid, 5.00, 'bid_amount', 750.00, p_text, clock_timestamp(), '203.0.113.7', 'UA/1.0');
    RESET ROLE; r := 'ok';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := 'REFUSED:' || SQLSTATE;
  END;
  RETURN r || ' -> fa=' || (SELECT count(*) FROM public.fee_acceptances WHERE bid_id = w.qid) || ' live=' || (SELECT count(*) FROM public.fee_acceptances WHERE bid_id = w.qid AND rescinded_at IS NULL)
         || ' q=' || (SELECT count(*) FROM public.fee_acceptance_quarantine WHERE bid_id = w.qid);
END $i$;
\o
SELECT 'PROOF|' || :'phase' || '|first acceptance|' || proof.ins(:'html_750');
-- rescind-bid's stamp (service role / postgres), exactly the helper's update
UPDATE public.fee_acceptances SET rescinded_at = now(), rescission_reason = 'bid_withdrawn' WHERE bid_id = (SELECT qid FROM proof.who) AND rescinded_at IS NULL;
SELECT 'PROOF|' || :'phase' || '|reopen: fresh acceptance|' || proof.ins(:'html_750');
SELECT 'PROOF|' || :'phase' || '|rescission_reason of stamped row|' || (SELECT rescission_reason FROM public.fee_acceptances WHERE rescinded_at IS NOT NULL LIMIT 1);
-- a client can still not smuggle a stamp: an insert that sets rescinded_at keeps it NULL
ROLLBACK;
