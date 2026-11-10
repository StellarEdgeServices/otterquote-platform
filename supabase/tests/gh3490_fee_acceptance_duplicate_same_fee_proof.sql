-- gh-3490 proof: the fee_acceptances guard's duplicate_bid rule counts only a row with the same bid_id AND the same fee (one cent). Run by gh3490_fee_acceptance_duplicate_same_fee_proof_run.sh.
-- THROWAWAY Postgres only (schema: gh3409_throwaway_schema.sql, then the gh3409 forward file = today's production guard). Never run against production.
-- psql -v phase=before|after|rollback -f texts.psql -f this_file. before / rollback = today's gh3409 guard; after = gh3490 forward applied.
-- Everything is inside BEGIN ... ROLLBACK. Output: PROOF|phase|case|expected|actual|OK/FAIL ... then FAILING=n of m.
-- An insert result reads `<ok|REFUSED:sqlstate> -> fa=<rows in fee_acceptances for that bid> q=<rows in the quarantine table for that bid>[:reasons]`.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;
\o /dev/null
SELECT set_config('proof.phase', :'phase', false);
CREATE SCHEMA proof;
CREATE TABLE proof.q (label text PRIMARY KEY, quote_id uuid, claim_id uuid, contractor_id uuid);
CREATE TABLE proof.res (ord serial, case_name text, expected text, actual text, ok boolean);
CREATE TABLE proof.people (who text PRIMARY KEY, user_id uuid, contractor_id uuid);
INSERT INTO proof.people SELECT 'u1', gen_random_uuid(), gen_random_uuid();
INSERT INTO public.contractors (id, user_id) SELECT contractor_id, user_id FROM proof.people;

-- a bid created by the contractor's own session (the model of gh-2519 sets the fee: 5% of total_price)
CREATE FUNCTION proof.cq(p_label text, p_total numeric) RETURNS void LANGUAGE plpgsql AS $q$
DECLARE c uuid := gen_random_uuid(); k uuid; uid uuid; qid uuid;
BEGIN
  SELECT contractor_id, user_id INTO k, uid FROM proof.people WHERE who = 'u1';
  INSERT INTO public.claims(id) VALUES (c);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount) VALUES (c, k, p_total, 0, 0) RETURNING id INTO qid;
  RESET ROLE;
  INSERT INTO proof.q VALUES (p_label, qid, c, k);
END $q$;
-- the contractor changes the bid's price from its own session (change / renew mode); the server recomputes the fee
CREATE FUNCTION proof.reprice(p_label text, p_total numeric) RETURNS text LANGUAGE plpgsql AS $r$
DECLARE uid uuid; f text;
BEGIN
  SELECT user_id INTO uid FROM proof.people WHERE who = 'u1';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.quotes SET total_price = p_total WHERE id = (SELECT quote_id FROM proof.q WHERE label = p_label);
  RESET ROLE;
  SELECT 'bid fee=' || fee_amount INTO f FROM public.quotes WHERE id = (SELECT quote_id FROM proof.q WHERE label = p_label);
  RETURN f;
END $r$;
CREATE FUNCTION proof.where_(p_label text) RETURNS text LANGUAGE plpgsql AS $w$
DECLARE bid uuid; fa integer; qn integer; rs text;
BEGIN
  SELECT quote_id INTO bid FROM proof.q WHERE label = p_label;
  SELECT count(*) INTO fa FROM public.fee_acceptances WHERE bid_id = bid;
  SELECT count(*), coalesce(string_agg(array_to_string(reasons, '+'), ',' ORDER BY ctid), '') INTO qn, rs FROM public.fee_acceptance_quarantine WHERE bid_id = bid;
  RETURN 'fa=' || fa || ' q=' || qn || CASE WHEN qn > 0 THEN ':' || rs ELSE '' END;
END $w$;
-- one acceptance INSERT from the contractor's own session (the forms' row shape); p_fee is the browser's own fee_amount column
CREATE FUNCTION proof.ins(p_label text, p_text text, p_fee numeric) RETURNS text LANGUAGE plpgsql AS $i$
DECLARE qr proof.q; uid uuid; r text;
BEGIN
  SELECT * INTO qr FROM proof.q WHERE label = p_label;
  SELECT user_id INTO uid FROM proof.people WHERE who = 'u1';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent)
      VALUES (qr.contractor_id, qr.claim_id, qr.quote_id, 5.00, 'bid_amount', p_fee, p_text, clock_timestamp(), '203.0.113.7', 'UA/1.0');
    RESET ROLE; r := 'ok';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := 'REFUSED:' || SQLSTATE;
  END;
  RETURN r || ' -> ' || proof.where_(p_label);
END $i$;
-- the stored fees for a bid, oldest first (created_at is now() for the whole transaction, so ctid orders them)
CREATE FUNCTION proof.fees(p_label text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(fee_amount::text, ',' ORDER BY ctid), 'none') FROM public.fee_acceptances WHERE bid_id = (SELECT quote_id FROM proof.q WHERE label = p_label) $f$;
-- stripe-webhook's pick, as supabase/functions/stripe-webhook/fee-acceptance-select.ts:29-43 does it today: the NEWEST row of the bid, then its fee must equal the bid's current fee
CREATE FUNCTION proof.wh_today(p_label text) RETURNS text LANGUAGE plpgsql AS $n$
DECLARE sq public.quotes; fa public.fee_acceptances;
BEGIN
  SELECT * INTO sq FROM public.quotes WHERE id = (SELECT quote_id FROM proof.q WHERE label = p_label);
  SELECT * INTO fa FROM public.fee_acceptances WHERE bid_id = sq.id AND rescinded_at IS NULL ORDER BY created_at DESC, ctid DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'no_row_for_selected_bid'; END IF;
  IF abs(fa.fee_amount - sq.fee_amount) >= 0.005 THEN RETURN 'fee_differs_from_bid (newest row ' || fa.fee_amount || ', bid ' || sq.fee_amount || ')'; END IF;
  RETURN 'ok fee=' || fa.fee_amount;
END $n$;
-- the rule the CTO brief states: the newest row whose fee equals the bid's current fee
CREATE FUNCTION proof.wh_spec(p_label text) RETURNS text LANGUAGE sql AS $s$
  SELECT coalesce((SELECT 'ok fee=' || fa.fee_amount FROM public.fee_acceptances fa JOIN public.quotes x ON x.id = fa.bid_id
     WHERE x.id = (SELECT quote_id FROM proof.q WHERE label = p_label) AND fa.rescinded_at IS NULL AND abs(fa.fee_amount - x.fee_amount) < 0.005
     ORDER BY fa.created_at DESC, fa.ctid DESC LIMIT 1), 'no matching row') $s$;
CREATE FUNCTION proof.rec(p_case text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $r$
  INSERT INTO proof.res(case_name, expected, actual, ok)
  SELECT p_case, e, p_actual, e = p_actual FROM (SELECT CASE current_setting('proof.phase') WHEN 'after' THEN p_after ELSE p_before END AS e) s $r$;
GRANT USAGE ON SCHEMA proof TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO authenticated;
GRANT SELECT ON proof.q, proof.people TO authenticated;

-- texts: :'html_<fee>' / :'react_<fee>' are the two forms' real disclosure texts at 5% for that fee (750 = $750.00 on a $15,000 bid), rendered from the form source files by gh3490_render_texts.mjs.
-- Since gh-3480 both forms render the same #547 item 1A wording; both are still run.
SELECT proof.cq('d1', 15000); SELECT proof.cq('d2', 15000); SELECT proof.cq('d3', 15000); SELECT proof.cq('d3r', 15000); SELECT proof.cq('d4', 15000); SELECT proof.cq('d4b', 15000);
SELECT proof.cq('d5', 15000); SELECT proof.cq('d6', 15000); SELECT proof.cq('d7', 15000); SELECT proof.cq('d7b', 15000); SELECT proof.cq('d8', 15000);

-- ======================= D1: first acceptance (unchanged) =======================
SELECT proof.rec('D1 first acceptance of a new bid is recorded', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('d1', :'html_750', 750.00));

-- ======================= D2: SAME fee again (renew or change at an unchanged price) = duplicate in both phases (failing control: today does this too) =======================
SELECT proof.ins('d2', :'html_750', 750.00);
SELECT proof.rec('D2 second row, same bid, SAME fee: quarantined duplicate_bid', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=1 q=1:duplicate_bid', proof.ins('d2', :'html_750', 750.00));

-- ======================= D3: changed bid, DIFFERENT fee that matches the bid's current fee = a new acceptance (fails today, passes after) =======================
SELECT proof.ins('d3', :'html_750', 750.00);
SELECT proof.rec('D3a contractor changes the bid to $16,000', 'bid fee=800.00', 'bid fee=800.00', proof.reprice('d3', 16000));
SELECT proof.rec('D3b HTML form acceptance at the new fee $800.00 (the bid''s current fee)', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=2 q=0', proof.ins('d3', :'html_800', 800.00));
SELECT proof.rec('D3c stored fees, oldest first', '750.00', '750.00,800.00', proof.fees('d3'));
SELECT proof.rec('D3d stripe-webhook pick (today''s code) on the changed bid', 'fee_differs_from_bid (newest row 750.00, bid 800.00)', 'ok fee=800.00', proof.wh_today('d3'));
SELECT proof.ins('d3r', :'react_750', 750.00);
SELECT proof.reprice('d3r', 16000);
SELECT proof.rec('D3e React form acceptance at the new fee $800.00', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=2 q=0',
  proof.ins('d3r', :'react_800', 800.00));

-- ======================= D4: a fee that does NOT match the bid's current fee is still diverted by the existing fee check =======================
SELECT proof.ins('d4', :'html_750', 750.00);
SELECT proof.reprice('d4', 16000);
SELECT proof.rec('D4 changed bid ($800.00) but the screen showed the OLD $750.00: fee check diverts it', 'ok -> fa=1 q=1:displayed_fee_differs+duplicate_bid', 'ok -> fa=1 q=1:displayed_fee_differs',
  proof.ins('d4', :'html_750', 750.00));
SELECT proof.ins('d4b', :'html_750', 750.00);
SELECT proof.rec('D4b unchanged bid, honest text, browser fee_amount 1.00: still a duplicate (the rule compares the server fee, not the browser column)', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=1 q=1:duplicate_bid',
  proof.ins('d4b', :'html_750', 1.00));
SELECT proof.rec('D4c a $1.00 fee printed in the text on the unchanged bid', 'ok -> fa=1 q=2:duplicate_bid,displayed_fee_differs+duplicate_bid', 'ok -> fa=1 q=2:duplicate_bid,displayed_fee_differs+duplicate_bid',
  proof.ins('d4b', :'html_1', 1.00));

-- ======================= D5: three prices, three acceptances =======================
SELECT proof.ins('d5', :'html_750', 750.00);
SELECT proof.reprice('d5', 16000); SELECT proof.ins('d5', :'html_800', 800.00);
SELECT proof.reprice('d5', 17000);
SELECT proof.rec('D5 third price $17,000 (fee $850.00)', 'ok -> fa=1 q=2:duplicate_bid,duplicate_bid', 'ok -> fa=3 q=0', proof.ins('d5', :'html_850', 850.00));

-- ======================= D6: price goes A -> B -> A. The return to A is a duplicate of the first row; the webhook finding =======================
SELECT proof.ins('d6', :'html_750', 750.00);
SELECT proof.reprice('d6', 16000); SELECT proof.ins('d6', :'html_800', 800.00);
SELECT proof.reprice('d6', 15000);
SELECT proof.rec('D6a back to $15,000: the $750.00 acceptance already exists, so duplicate_bid', 'ok -> fa=1 q=2:duplicate_bid,duplicate_bid', 'ok -> fa=2 q=1:duplicate_bid', proof.ins('d6', :'html_750', 750.00));
SELECT proof.rec('D6b stored fees, oldest first', '750.00', '750.00,800.00', proof.fees('d6'));
SELECT proof.rec('D6c FINDING stripe-webhook today: newest row (800.00) is checked and refused, though a 750.00 row exists', 'ok fee=750.00', 'fee_differs_from_bid (newest row 800.00, bid 750.00)', proof.wh_today('d6'));
SELECT proof.rec('D6d the brief''s rule (newest row whose fee equals the bid''s) would use it', 'ok fee=750.00', 'ok fee=750.00', proof.wh_spec('d6'));

-- ======================= D7: the one-cent tolerance =======================
SELECT proof.ins('d7', :'html_750', 750.00);
SELECT proof.rec('D7a bid moved to $15,000.20 (fee $750.01)', 'bid fee=750.01', 'bid fee=750.01', proof.reprice('d7', 15000.20));
SELECT proof.rec('D7b fee one cent away is the same fee: duplicate', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=1 q=1:duplicate_bid', proof.ins('d7', :'html_75001', 750.01));
SELECT proof.ins('d7b', :'html_750', 750.00);
SELECT proof.rec('D7c bid moved to $15,000.40 (fee $750.02)', 'bid fee=750.02', 'bid fee=750.02', proof.reprice('d7b', 15000.40));
SELECT proof.rec('D7d fee two cents away is a new acceptance', 'ok -> fa=1 q=1:duplicate_bid', 'ok -> fa=2 q=0', proof.ins('d7b', :'html_75002', 750.02));

-- ======================= D8: a bid with no fee still counts any existing row as a duplicate (unchanged) =======================
SELECT proof.ins('d8', :'html_750', 750.00);
ALTER TABLE public.quotes DISABLE TRIGGER quotes_model_server_fee;
ALTER TABLE public.quotes ALTER COLUMN fee_amount DROP NOT NULL;   -- production's quotes.fee_amount is NOT NULL (read 2026-11-09), so this path is unreachable there; pinned only so the v_amt IS NULL branch keeps today's behaviour
UPDATE public.quotes SET fee_amount = NULL WHERE id = (SELECT quote_id FROM proof.q WHERE label = 'd8');
ALTER TABLE public.quotes ENABLE TRIGGER quotes_model_server_fee;
SELECT proof.rec('D8 bid lost its fee: bid_has_no_fee AND duplicate_bid, as today', 'ok -> fa=1 q=1:bid_has_no_fee+duplicate_bid', 'ok -> fa=1 q=1:bid_has_no_fee+duplicate_bid', proof.ins('d8', :'html_750', 750.00));

-- ======================= STATE =======================
SELECT proof.rec('S1 guard body md5 prefix', '1142fe98', '3ff983cb', (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.fee_acceptances_guard_client_insert()'::regprocedure));
SELECT proof.rec('S2 trigger enabled, BEFORE INSERT FOR EACH ROW', '1', '1', (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal
   AND tgname = 'fee_acceptances_guard_client_insert' AND tgenabled = 'O' AND tgtype = 7));
SELECT proof.rec('S3 function comment, owner and search_path kept', 'gh-3409|postgres|search_path=public, pg_temp', 'gh-3409|postgres|search_path=public, pg_temp',
  (SELECT left(obj_description(p.oid, 'pg_proc'), 7) || '|' || pg_get_userbyid(p.proowner) || '|' || array_to_string(p.proconfig, ',') FROM pg_proc p WHERE p.oid = 'public.fee_acceptances_guard_client_insert()'::regprocedure));
SELECT proof.rec('S4 helper functions untouched (text check, quarantine writer) md5 prefixes', '462c15be,92e5a329', '462c15be,92e5a329',
  (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.fee_acceptance_text_check(text,numeric,numeric,numeric)'::regprocedure) || ',' ||
  (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)'::regprocedure));

\o
SELECT 'PROOF|' || current_setting('proof.phase') || '|' || case_name || '|expected=' || expected || '|actual=' || actual || '|' || CASE WHEN ok THEN 'OK' ELSE 'FAIL' END FROM proof.res ORDER BY ord;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof.res;
ROLLBACK;
