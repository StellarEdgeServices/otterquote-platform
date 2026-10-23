-- gh-2997 proof: quotes / activity_log inherit is_test from the claim (draft migration
-- supabase/migrations_drafts/gh2997_inherit_is_test.sql).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement batch that is forced to roll back (constitution R-173/R-174:
-- only is_test rows are addressed; the last statement is a deliberate RAISE EXCEPTION, so nothing commits).
--   BEFORE the fix : run this file alone.          -> negative control: T1/T2/T5 show is_test=false (the defect)
--   AFTER the fix  : run the migration body (its own BEGIN; / COMMIT; lines removed) followed by this file, same batch.
-- Fixtures (all is_test=true, verified by SELECT before the run): claim cbf2c780-701b-406c-9f2f-90db54de6bd1 (status bidding),
--   contractors 2bc792be-b677-4ac1-bc68-94b1561d9757 (T1; passes the D-199 gate), 986ce2b6-39fd-4a2c-aba4-a806c618c8c0 and bb07fc40-3607-4f3f-ac44-dffd4ca95111 (T4/T5 with is_auto_bid=true, which skips the D-199 gate; all three is_test=true). T4/T5 flip that claim to is_test=false INSIDE the
--   transaction to stand in for a real claim; no real claim row is read or written.
-- Expected BEFORE: R0 wrong_quotes=2 wrong_activity=6; T1 quote.is_test=false submitted.is_test=false; T2 false; T5 (flip-to-true
--   control, claim real) false; T3 false; T6 'not-a-uuid' accepted false.
-- (AFTER run also printed P1 false,false,false,false from has_function_privilege(anon/authenticated, ..., 'EXECUTE') on both functions;
--  in this file P1 shows the function name when it exists, 'absent' before the fix.)
-- Expected AFTER : R0 same (it runs before the migration body only in the BEFORE run; in the AFTER run R0 is measured after the
--   backfill: wrong_quotes=0 wrong_activity=0); 471b2b5a is_test=true; T1 true/true/true; T2 true; T3 false (no key);
--   T4 false (real claim: not mislabelled); T5 true (an explicit true is never lowered); T6 false, no error.

CREATE TEMP TABLE _r(k text, v text) ON COMMIT DROP;
-- (migration body is spliced here for the AFTER run; the BEFORE run has nothing here)
-- @@MIGRATION@@

INSERT INTO _r SELECT 'P1 anon/authenticated EXECUTE on the two functions (want false,false,false,false)', COALESCE(to_regprocedure('public.quotes_inherit_is_test()')::text,'absent');
INSERT INTO _r SELECT 'R0 wrong_quotes_vs_claim', count(*)::text FROM quotes q JOIN claims c ON c.id = q.claim_id WHERE c.is_test AND NOT q.is_test;
INSERT INTO _r SELECT 'R0 wrong_activity_vs_claim', count(*)::text FROM activity_log a JOIN claims c ON c.id = nullif(a.metadata->>'claim_id','')::uuid WHERE c.is_test AND NOT a.is_test;
INSERT INTO _r SELECT 'R0 quote 471b2b5a is_test', is_test::text FROM quotes WHERE id = '471b2b5a-fb94-4558-aaf7-aa1670d000a2';
INSERT INTO _r SELECT 'R0 activity of 471b2b5a is_test', string_agg(event_type || '=' || is_test, ',') FROM activity_log WHERE metadata->>'quote_id' = '471b2b5a-fb94-4558-aaf7-aa1670d000a2';

-- the fixture claim's bid window expired 2026-09-16; clear it inside this rolled-back transaction so a bid can be placed
UPDATE claims SET bid_window_expires_at = NULL WHERE id = 'cbf2c780-701b-406c-9f2f-90db54de6bd1';

DO $t$
DECLARE qid uuid; r text;
BEGIN
  -- T1: bid placed and accepted on an is_test claim, is_test not supplied (what the bid form does)
  BEGIN
    INSERT INTO quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status)
    VALUES ('cbf2c780-701b-406c-9f2f-90db54de6bd1','2bc792be-b677-4ac1-bc68-94b1561d9757',15000,1,150,'submitted') RETURNING id INTO qid;
    INSERT INTO _r SELECT 'T1 quote.is_test', is_test::text FROM quotes WHERE id = qid;
    INSERT INTO _r SELECT 'T1 bid_submitted.is_test', coalesce(string_agg(is_test::text, ','), 'NO ROW') FROM activity_log WHERE metadata->>'quote_id' = qid::text AND event_type='bid_submitted';
    UPDATE quotes SET status='selected' WHERE id = qid;
    INSERT INTO _r SELECT 'T1 bid_accepted.is_test', coalesce(string_agg(is_test::text, ','), 'NO ROW') FROM activity_log WHERE metadata->>'quote_id' = qid::text AND event_type='bid_accepted';
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T1 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
  -- T2: a direct activity_log insert (Edge Function style) that names a test claim, is_test left at its default
  BEGIN
    INSERT INTO activity_log(user_id, event_type, title, metadata)
    SELECT user_id, 'gh2997_probe', 'probe', jsonb_build_object('claim_id','cbf2c780-701b-406c-9f2f-90db54de6bd1') FROM activity_log LIMIT 1 RETURNING is_test::text INTO r;
    INSERT INTO _r VALUES ('T2 activity(claim_id=test).is_test', coalesce(r,'NO ROW'));
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T2 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
  -- T3: no claim key at all stays as written
  BEGIN
    INSERT INTO activity_log(user_id, event_type, title)
    SELECT user_id, 'gh2997_probe', 'probe' FROM activity_log LIMIT 1 RETURNING is_test::text INTO r;
    INSERT INTO _r VALUES ('T3 activity(no key).is_test', coalesce(r,'NO ROW'));
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T3 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
  -- T6: a non-uuid claim_id must not raise
  BEGIN
    INSERT INTO activity_log(user_id, event_type, title, metadata)
    SELECT user_id, 'gh2997_probe', 'probe', jsonb_build_object('claim_id','not-a-uuid') FROM activity_log LIMIT 1 RETURNING is_test::text INTO r;
    INSERT INTO _r VALUES ('T6 activity(claim_id=not-a-uuid).is_test', coalesce(r,'NO ROW') || ' accepted');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T6 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
END $t$;

-- T4/T5: stand-in for a real claim (flip the test fixture claim to false inside this rolled-back transaction)
UPDATE claims SET is_test = false WHERE id = 'cbf2c780-701b-406c-9f2f-90db54de6bd1';
DO $t$
DECLARE qid uuid;
BEGIN
  BEGIN
    INSERT INTO quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, is_auto_bid)
    VALUES ('cbf2c780-701b-406c-9f2f-90db54de6bd1','986ce2b6-39fd-4a2c-aba4-a806c618c8c0',16000,1,160,'submitted', true) RETURNING id INTO qid;
    INSERT INTO _r SELECT 'T4 quote on real-claim stand-in.is_test', is_test::text FROM quotes WHERE id = qid;
    INSERT INTO _r SELECT 'T4 its bid_submitted.is_test', coalesce(string_agg(is_test::text, ','), 'NO ROW') FROM activity_log WHERE metadata->>'quote_id' = qid::text AND event_type='bid_submitted';
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T4 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
  BEGIN
    INSERT INTO quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, is_test, is_auto_bid)
    VALUES ('cbf2c780-701b-406c-9f2f-90db54de6bd1','bb07fc40-3607-4f3f-ac44-dffd4ca95111',17000,1,170,'submitted', true, true) RETURNING id INTO qid;
    INSERT INTO _r SELECT 'T5 explicit is_test=true on real-claim stand-in', is_test::text FROM quotes WHERE id = qid;
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('T5 ERROR', SQLSTATE || ' ' || left(SQLERRM,120));
  END;
END $t$;

DO $f$
DECLARE s text;
BEGIN
  SELECT string_agg(k || ' => ' || coalesce(v,'NULL'), E'\n' ORDER BY k) INTO s FROM _r;
  RAISE EXCEPTION E'GH2997 PROOF (forced rollback)\n%', s USING ERRCODE = 'P0U01';
END $f$;
