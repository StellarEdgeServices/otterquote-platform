-- gh-3409 proof, run by gh3409_fee_acceptances_client_insert_guard_proof_run.sh on a THROWAWAY Postgres (schema: gh3409_throwaway_schema.sql). Never run against production.
-- psql -v phase=before|after [-v composed=1] -f texts.psql -f this_file. `before` = today's behaviour (negative control: forged inserts SUCCEED); `after` = with the forward file applied.
-- Everything is inside BEGIN ... ROLLBACK. Output: PROOF|phase|case|expected|actual|OK/FAIL ... then FAILING=n of m.
-- An insert result reads `<ok|REFUSED:sqlstate> -> fa=<rows in fee_acceptances for that bid> q=<rows in the quarantine table>[:reasons]`.
\set ON_ERROR_STOP on
\if :{?composed}
\else
\set composed 0
\endif
\pset format unaligned
\pset tuples_only on
BEGIN;
\o /dev/null
SELECT set_config('proof.phase', :'phase', false), set_config('proof.composed', :'composed', false);
CREATE SCHEMA proof;
CREATE TABLE proof.q (label text PRIMARY KEY, quote_id uuid, claim_id uuid, contractor_id uuid);
CREATE TABLE proof.res (ord serial, case_name text, expected text, actual text, ok boolean);
CREATE TABLE proof.people (who text PRIMARY KEY, user_id uuid, contractor_id uuid);
INSERT INTO proof.people SELECT 'u1', gen_random_uuid(), gen_random_uuid() UNION ALL SELECT 'u2', gen_random_uuid(), gen_random_uuid() UNION ALL SELECT 'u3', gen_random_uuid(), gen_random_uuid();
INSERT INTO public.contractors (id, user_id, address_state) SELECT contractor_id, user_id, CASE WHEN who = 'u3' THEN 'IN' END FROM proof.people;
-- a state-specific fee row, as the admin fee page could add (the forms cannot see it: they read contractors.state, which does not exist)
INSERT INTO public.platform_fee_config (state, trade, fee_pct, fee_basis) VALUES ('IN', NULL, 7.00, 'bid_amount');
-- a seeded bid (superuser); the model trigger sets the fee as gh-2519 does; age in hours
CREATE FUNCTION proof.mk(p_label text, p_who text, p_total numeric, p_status text DEFAULT 'submitted', p_age_h numeric DEFAULT 0) RETURNS void LANGUAGE plpgsql AS $m$
DECLARE c uuid := gen_random_uuid(); qid uuid := gen_random_uuid(); k uuid;
BEGIN
  SELECT contractor_id INTO k FROM proof.people WHERE who = p_who;
  INSERT INTO public.claims(id) VALUES (c);
  INSERT INTO public.quotes(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, created_at) VALUES (qid, c, k, p_total, 0, 0, p_status, now() - (p_age_h || ' hours')::interval);
  INSERT INTO proof.q VALUES (p_label, qid, c, k);
END $m$;
SELECT proof.mk('q1','u1',18500); SELECT proof.mk('q2','u1',15000); SELECT proof.mk('q3','u1',4000,'submitted',24); SELECT proof.mk('q4','u2',9000);
SELECT proof.mk('q5','u1',15000,'selected'); SELECT proof.mk('q6','u1',12345.50); SELECT proof.mk('q6b','u1',12345.50); SELECT proof.mk('q7','u1',15000);
SELECT proof.mk('q8','u1',15000); SELECT proof.mk('q9','u1',15000); SELECT proof.mk('q10','u1',15000); SELECT proof.mk('q11','u1',15000);
SELECT proof.mk('q12','u1',15000); SELECT proof.mk('q13','u1',15000); SELECT proof.mk('q14','u1',15000); SELECT proof.mk('q15','u1',15000);
SELECT proof.mk('q16','u1',15000); SELECT proof.mk('q17','u1',15000); SELECT proof.mk('q18','u1',4000,'submitted',24);
SELECT proof.mk('k1','u1',15000); SELECT proof.mk('k2','u1',15000); SELECT proof.mk('k3','u1',15000); SELECT proof.mk('k4','u1',15000); SELECT proof.mk('k5','u1',15000); SELECT proof.mk('k6a','u1',15000); SELECT proof.mk('k6b','u1',15000); SELECT proof.mk('k6c','u1',15000); SELECT proof.mk('k7','u1',15000); SELECT proof.mk('k9','u1',15000); SELECT proof.mk('k10','u1',15000); SELECT proof.mk('k12','u1',15000); SELECT proof.mk('k13','u1',15000);
SELECT proof.mk('k14','u1',15000); SELECT proof.mk('k15','u1',15000); SELECT proof.mk('k16','u1',15000); SELECT proof.mk('k17','u1',15000); SELECT proof.mk('k18','u1',15000);
SELECT proof.mk('q20','u1',15000); SELECT proof.mk('q21','u1',15000); SELECT proof.mk('q22','u1',15000); SELECT proof.mk('q23','u1',15000); SELECT proof.mk('q24','u1',15000);

-- run any statement as a client session; ok or REFUSED:<sqlstate>
CREATE FUNCTION proof.cs(p_role text, p_who text, p_sql text) RETURNS text LANGUAGE plpgsql AS $c$
DECLARE uid uuid;
BEGIN
  SELECT user_id INTO uid FROM proof.people WHERE who = p_who;
  IF p_role = 'anon' THEN uid := NULL; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', p_role, 'email', 'x@example.test')::text, true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  EXECUTE p_sql;
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RESET ROLE; RETURN 'REFUSED:' || SQLSTATE;
END $c$;
-- a bid created by the contractor's own session (client INSERT into quotes with forged fee columns; the server sets them), optionally on another bid's claim
CREATE FUNCTION proof.cq(p_label text, p_who text, p_total numeric, p_claim_of text DEFAULT NULL, p_created timestamptz DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $q$
DECLARE c uuid; k uuid; uid uuid; qid uuid;
BEGIN
  SELECT contractor_id, user_id INTO k, uid FROM proof.people WHERE who = p_who;
  IF p_claim_of IS NULL THEN c := gen_random_uuid(); INSERT INTO public.claims(id) VALUES (c); ELSE SELECT claim_id INTO c FROM proof.q WHERE label = p_claim_of; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, created_at) VALUES (c, k, p_total, 99, 99, 99, COALESCE(p_created, now())) RETURNING id INTO qid;
  RESET ROLE;
  INSERT INTO proof.q VALUES (p_label, qid, c, k);
END $q$;
CREATE FUNCTION proof.qfee(p_label text) RETURNS text LANGUAGE sql AS $f$ SELECT 'pct=' || platform_fee_pct || ' fee=' || fee_amount FROM public.quotes WHERE id = (SELECT quote_id FROM proof.q WHERE label = p_label) $f$;

-- where did the acceptance for a bid end up
CREATE FUNCTION proof.where_(p_label text) RETURNS text LANGUAGE plpgsql AS $w$
DECLARE bid uuid; fa integer; qn integer := 0; rs text := '';
BEGIN
  SELECT quote_id INTO bid FROM proof.q WHERE label = p_label;
  SELECT count(*) INTO fa FROM public.fee_acceptances WHERE bid_id = bid;
  IF to_regclass('public.fee_acceptance_quarantine') IS NOT NULL THEN
    EXECUTE 'SELECT count(*), coalesce(string_agg(array_to_string(reasons, ''+''), '',''), '''') FROM public.fee_acceptance_quarantine WHERE bid_id = $1' INTO qn, rs USING bid;
  END IF;
  RETURN 'fa=' || fa || ' q=' || qn || CASE WHEN qn > 0 THEN ':' || rs ELSE '' END;
END $w$;
-- one acceptance INSERT as a given role. Default identity is the bid's own contractor.
CREATE FUNCTION proof.ins(p_role text, p_who text, p_label text, p_text text, p_pct numeric, p_fee numeric,
  p_accepted timestamptz DEFAULT now(), p_created timestamptz DEFAULT NULL, p_invoice text DEFAULT NULL, p_resc timestamptz DEFAULT NULL,
  p_claim_label text DEFAULT NULL, p_contractor_who text DEFAULT NULL, p_bid uuid DEFAULT NULL, p_basis text DEFAULT 'bid_amount', p_reason text DEFAULT NULL, p_id uuid DEFAULT gen_random_uuid(), p_ip text DEFAULT '203.0.113.7', p_ua text DEFAULT 'UA/1.0') RETURNS text LANGUAGE plpgsql AS $i$
DECLARE qr proof.q; uid uuid; cid uuid; claim uuid; bid uuid; r text;
BEGIN
  SELECT * INTO qr FROM proof.q WHERE label = p_label;
  SELECT user_id INTO uid FROM proof.people WHERE who = p_who;
  SELECT contractor_id INTO cid FROM proof.people WHERE who = COALESCE(p_contractor_who, p_who);
  claim := COALESCE((SELECT claim_id FROM proof.q WHERE label = p_claim_label), qr.claim_id);
  bid := COALESCE(p_bid, qr.quote_id);
  IF p_role = 'anon' THEN uid := NULL; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', p_role, 'email', 'x@example.test')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
    INSERT INTO public.fee_acceptances (id, contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent, created_at, invoice_url, rescinded_at, rescission_reason)
      VALUES (p_id, cid, claim, bid, p_pct, p_basis, p_fee, p_text, p_accepted, p_ip::inet, p_ua, COALESCE(p_created, now()), p_invoice, p_resc, p_reason);
    RESET ROLE; r := 'ok';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := 'REFUSED:' || SQLSTATE;
  END;
  RETURN r || ' -> ' || proof.where_(p_label);
END $i$;
-- phase before = today; after = forward applied; rollback = forward then rollback (the quarantine TABLE is kept on purpose, so a few cases differ from before)
CREATE FUNCTION proof.rec(p_case text, p_before text, p_after text, p_actual text, p_rollback text DEFAULT NULL) RETURNS void LANGUAGE sql AS $r$
  INSERT INTO proof.res(case_name, expected, actual, ok)
  SELECT p_case, e, p_actual, e = p_actual FROM (SELECT CASE current_setting('proof.phase') WHEN 'before' THEN p_before WHEN 'rollback' THEN coalesce(p_rollback, p_before) ELSE p_after END AS e) s $r$;
CREATE FUNCTION proof.stored(p_label text, p_what text) RETURNS text LANGUAGE plpgsql AS $s$
DECLARE f public.fee_acceptances;
BEGIN
  SELECT fa.* INTO f FROM public.fee_acceptances fa JOIN proof.q q ON q.quote_id = fa.bid_id WHERE q.label = p_label ORDER BY fa.created_at LIMIT 1;
  IF NOT FOUND THEN RETURN 'no row'; END IF;
  IF p_what = 'fee' THEN RETURN 'fee_pct=' || f.fee_pct || ' fee_amount=' || f.fee_amount || ' basis=' || f.fee_basis; END IF;
  IF p_what = 'accepted_at' THEN RETURN CASE WHEN abs(extract(epoch FROM f.accepted_at - now())) < 60 THEN 'server time' ELSE 'client time kept' END; END IF;
  IF p_what = 'server_cols' THEN RETURN 'created=' || CASE WHEN abs(extract(epoch FROM f.created_at - now())) < 60 THEN 'now' ELSE 'client-chosen' END
     || ' invoice=' || CASE WHEN f.invoice_url IS NULL THEN 'null' ELSE 'set' END || ' rescinded=' || CASE WHEN f.rescinded_at IS NULL THEN 'null' ELSE 'set' END || ' reason=' || CASE WHEN f.rescission_reason IS NULL THEN 'null' ELSE 'set' END; END IF;
  RETURN '?';
END $s$;
-- what the diverted record holds (after only)
CREATE FUNCTION proof.held(p_label text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r text;
BEGIN
  IF to_regclass('public.fee_acceptance_quarantine') IS NULL THEN RETURN 'no quarantine table'; END IF;
  EXECUTE 'SELECT ''shown='' || substring(fee_text_displayed from ''\$[0-9,.]+'') || '' client_fee='' || fee_amount || '' server='' || server_fee_amount || '' pct='' || server_fee_pct FROM public.fee_acceptance_quarantine WHERE bid_id = (SELECT quote_id FROM proof.q WHERE label = $1) LIMIT 1' INTO r USING p_label;
  RETURN coalesce(r, 'no held row');
END $h$;
-- the quarantined row as sent
CREATE FUNCTION proof.held_as_sent(p_label text, p_sent_id uuid, p_sent_accepted timestamptz, p_sent_created timestamptz) RETURNS text LANGUAGE plpgsql AS $h2$
DECLARE r text;
BEGIN
  IF to_regclass('public.fee_acceptance_quarantine') IS NULL THEN RETURN 'no quarantine table'; END IF;
  EXECUTE 'SELECT ''accepted_at='' || CASE WHEN accepted_at = $2 THEN ''as sent'' ELSE ''changed'' END || '' id='' || CASE WHEN client_row_id = $3 THEN ''as sent'' ELSE ''changed'' END || '' created_at='' || CASE WHEN client_created_at = $4 THEN ''as sent'' ELSE ''changed'' END FROM public.fee_acceptance_quarantine WHERE bid_id = (SELECT quote_id FROM proof.q WHERE label = $1) LIMIT 1' INTO r USING p_label, p_sent_accepted, p_sent_id, p_sent_created;
  RETURN coalesce(r, 'no held row');
END $h2$;
CREATE FUNCTION proof.held_len(p_label text) RETURNS text LANGUAGE plpgsql AS $hl$
DECLARE r text;
BEGIN
  IF to_regclass('public.fee_acceptance_quarantine') IS NULL THEN RETURN 'no quarantine table'; END IF;
  EXECUTE 'SELECT ''stored='' || length(fee_text_displayed) || '' original='' || fee_text_length FROM public.fee_acceptance_quarantine WHERE bid_id = (SELECT quote_id FROM proof.q WHERE label = $1) LIMIT 1' INTO r USING p_label;
  RETURN coalesce(r, 'no held row');
END $hl$;
CREATE FUNCTION proof.held_ua_len(p_label text) RETURNS text LANGUAGE plpgsql AS $hu$
DECLARE r text;
BEGIN
  IF to_regclass('public.fee_acceptance_quarantine') IS NULL THEN RETURN 'no quarantine table'; END IF;
  EXECUTE 'SELECT ''ua='' || length(user_agent) FROM public.fee_acceptance_quarantine WHERE bid_id = (SELECT quote_id FROM proof.q WHERE label = $1) LIMIT 1' INTO r USING p_label;
  RETURN coalesce(r, 'no held row');
END $hu$;
CREATE FUNCTION proof.svc_privs() RETURNS text LANGUAGE sql AS $sp$
  SELECT CASE WHEN to_regclass('public.fee_acceptance_quarantine') IS NULL THEN 'no quarantine table'
  ELSE (SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('service_role', 'public.fee_acceptance_quarantine', p)) END $sp$;
-- one session diverts p_n mismatching acceptances; returns how many quarantine rows that caller has
CREATE FUNCTION proof.flood(p_who text, p_n integer) RETURNS text LANGUAGE plpgsql AS $fl$
DECLARE i integer; lbl text; n text;
BEGIN
  FOR i IN 1..p_n LOOP
    lbl := 'fl' || i; PERFORM proof.cq(lbl, p_who, 15000);
    PERFORM proof.ins('authenticated', p_who, lbl, 'junk ' || i, 5.00, 750.00);
  END LOOP;
  IF to_regclass('public.fee_acceptance_quarantine') IS NULL THEN RETURN 'no quarantine table'; END IF;
  EXECUTE 'SELECT count(*)::text FROM public.fee_acceptance_quarantine WHERE caller_user_id = (SELECT user_id FROM proof.people WHERE who = $1)' INTO n USING p_who;
  RETURN 'quarantine rows=' || n;
END $fl$;
-- the webhook's row choice. OLD = stripe-webhook/index.ts:494-502 as on main (newest row for claim and contractor). NEW = the SQL spec of supabase/functions/stripe-webhook/fee-acceptance-select.ts
-- (the row of the SELECTED bid, and only when its fee equals that bid's current fee); that file has its own Deno test.
CREATE FUNCTION proof.wh_old(p_label text) RETURNS text LANGUAGE sql AS $o$
  SELECT coalesce((SELECT 'fee_amount=' || fa.fee_amount FROM public.fee_acceptances fa JOIN proof.q q ON q.claim_id = fa.claim_id AND q.contractor_id = fa.contractor_id
   WHERE q.label = p_label AND fa.rescinded_at IS NULL ORDER BY fa.created_at DESC, fa.ctid DESC LIMIT 1), 'no row') $o$;   -- ctid breaks ties: one transaction has one now(), real inserts are separate transactions
CREATE FUNCTION proof.wh_new(p_label text) RETURNS text LANGUAGE plpgsql AS $n$
DECLARE sq public.quotes; fa public.fee_acceptances; pq proof.q;
BEGIN
  SELECT * INTO pq FROM proof.q WHERE label = p_label;
  SELECT * INTO sq FROM public.quotes WHERE claim_id = pq.claim_id AND contractor_id = pq.contractor_id AND status = 'selected' ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'no selected bid'; END IF;
  SELECT * INTO fa FROM public.fee_acceptances WHERE bid_id = sq.id AND rescinded_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'no row for the selected bid'; END IF;
  IF fa.fee_amount IS DISTINCT FROM sq.fee_amount THEN RETURN 'not evidence: row fee ' || fa.fee_amount || ' differs from bid fee ' || sq.fee_amount; END IF;
  RETURN 'fee_amount=' || fa.fee_amount;
END $n$;
-- a server-side function owned by the table owner (SECURITY DEFINER), the shape of any future RPC writer
CREATE FUNCTION proof.definer_write(p_label text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $d$
DECLARE qr proof.q;
BEGIN
  SELECT * INTO qr FROM proof.q WHERE label = p_label;
  INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed) VALUES (qr.contractor_id, qr.claim_id, qr.quote_id, 5.00, 'bid_amount', 1.00, 'written by a server-side function');
END $d$;
CREATE FUNCTION proof.via_definer(p_who text, p_label text) RETURNS text LANGUAGE plpgsql AS $v$
DECLARE uid uuid;
BEGIN
  SELECT user_id INTO uid FROM proof.people WHERE who = p_who;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM proof.definer_write(p_label);
  RESET ROLE;
  RETURN 'ok -> ' || proof.where_(p_label);
EXCEPTION WHEN OTHERS THEN RESET ROLE; RETURN 'REFUSED:' || SQLSTATE;
END $v$;
GRANT USAGE ON SCHEMA proof TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO authenticated, anon, service_role;
GRANT SELECT ON proof.q, proof.people TO authenticated, anon, service_role;

-- ======================= REAL ACCEPTANCE PATHS (recorded in fee_acceptances in every phase) =======================
SELECT proof.rec('R1 HTML form insert (text rendered from contractor-bid-form.html)', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q1', :'text_html_q1', 5.00, 925.00));
SELECT proof.rec('R1b R1 stored fee equals the bid''s', 'fee_pct=5.00 fee_amount=925.00 basis=bid_amount', 'fee_pct=5.00 fee_amount=925.00 basis=bid_amount', proof.stored('q1','fee'));
SELECT proof.rec('R2 React form insert (text rendered from react-app copy.ts)', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q2', :'text_react_q2', 5.00, 750.00));
SELECT proof.rec('R3 half-cent bid, HTML form float fee 617.275', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q6', :'text_html_q6', 5.00, 617.275));
SELECT proof.rec('R3b half-cent bid, React form (net rounds a cent differently)', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q6b', :'text_react_q6b', 5.00, 617.275));
SELECT proof.rec('R4 device clock 2h slow: row still recorded', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q7', :'text_html_q7', 5.00, 750.00, now() - interval '2 hours'));
SELECT proof.rec('R4b R4 accepted_at', 'client time kept', 'server time', proof.stored('q7','accepted_at'));
SELECT proof.rec('R5 service_role insert (Edge Function / seed shape, any values)', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('service_role','u1','q18','anything at all', 1.00, 1.00));
SELECT proof.rec('R5b SECURITY DEFINER server-side function insert, any values', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.via_definer('u1','q17'));
SELECT proof.rec('R6 genuine acceptance recorded late (slow IP lookup): 24h-old bid, true values', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q3', replace(:'text_html_q9','$750.00','$200.00'), 5.00, 200.00));
SELECT proof.rec('R7 genuine acceptance for a bid that is already selected, true values', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q5', :'text_html_q9', 5.00, 750.00));
SELECT proof.cq('r8','u1',15000, NULL, '2099-01-01 00:00:00+00');
SELECT proof.rec('R8 bid whose created_at the client set to 2099 still gets its genuine acceptance', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','r8', :'text_html_q9', 5.00, 750.00));

-- ======================= FORGERIES (today: recorded; after: refused, diverted or neutralised) =======================
SELECT proof.rec('F1a forged fee_pct/fee_amount, honest text: row recorded', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q9', :'text_html_q9', 0.01, 0.01));
SELECT proof.rec('F1a stored fee_pct/fee_amount', 'fee_pct=0.01 fee_amount=0.01 basis=bid_amount', 'fee_pct=5.00 fee_amount=750.00 basis=bid_amount', proof.stored('q9','fee'));
SELECT proof.rec('F1b forged fee AND matching forged text ($0.01)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs',
  proof.ins('authenticated','u1','q10', replace(replace(:'text_html_q9','$750.00','$0.01'),'(5.00%','(0.01%'), 0.01, 0.01));
SELECT proof.rec('F2 honest numbers, chosen text', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','q11', 'The contractor never agreed to any fee.', 5.00, 750.00));
SELECT proof.rec('F2b form text with a different dollar fee ($1.00)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','q12', replace(:'text_html_q9','$750.00','$1.00'), 5.00, 750.00));
SELECT proof.rec('F2c wording drift (one word changed; kept in quarantine, not lost)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','q13', :'text_html_drift', 5.00, 750.00));
SELECT proof.rec('F2d malformed digits $7,50.00 (REVIEW: matched before)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','q20', replace(:'text_html_q9','$750.00','$7,50.00'), 5.00, 750.00));
SELECT proof.rec('F2e malformed digits $0,750.00', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','q21', replace(:'text_html_q9','$750.00','$0,750.00'), 5.00, 750.00));
SELECT proof.rec('F2f malformed rate 005.00%', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','q22', replace(:'text_html_q9','(5.00%','(005.00%'), 5.00, 750.00));
SELECT proof.rec('F3 acceptance naming ANOTHER contractor''s bid', 'ok -> fa=1 q=0', 'REFUSED:42501 -> fa=0 q=0',
  proof.ins('authenticated','u1','q4', replace(:'text_html_q9','$750.00','$450.00'), 5.00, 450.00, p_contractor_who => 'u1'));
SELECT proof.rec('F3b row naming another contractor as the acceptor (policy; q4 holds the F3 row today)', 'REFUSED:42501 -> fa=1 q=0', 'REFUSED:42501 -> fa=0 q=0',
  proof.ins('authenticated','u1','q4', replace(:'text_html_q9','$750.00','$450.00'), 5.00, 450.00, p_contractor_who => 'u2'));
SELECT proof.rec('F4 own bid but another claim_id', 'ok -> fa=1 q=0', 'REFUSED:42501 -> fa=0 q=0', proof.ins('authenticated','u1','q14', :'text_html_q9', 5.00, 750.00, p_claim_label => 'q2'));
SELECT proof.rec('F5 nonexistent bid_id', 'REFUSED:23503 -> fa=0 q=0', 'REFUSED:42501 -> fa=0 q=0', proof.ins('authenticated','u1','q24', :'text_html_q9', 5.00, 750.00, p_bid => gen_random_uuid()));
SELECT proof.rec('F6 second (newer) acceptance for a bid that already has one', 'ok -> fa=2 q=0', 'ok -> fa=1 q=1:duplicate_bid', proof.ins('authenticated','u1','q1', :'text_html_q1', 5.00, 925.00));
SELECT proof.rec('F9 client sets created_at 2099, invoice_url, rescinded_at on a good insert', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0',
  proof.ins('authenticated','u1','q8', :'text_html_q9', 5.00, 750.00, now(), '2099-01-01 00:00:00+00', 'https://example.test/x', now(), p_reason => 'client wrote this'));
SELECT proof.rec('F9b F9 stored created_at/invoice/rescinded', 'created=client-chosen invoice=set rescinded=set reason=set', 'created=now invoice=null rescinded=null reason=null', proof.stored('q8','server_cols'));
SELECT proof.rec('F10 anon insert', 'REFUSED:42501 -> fa=0 q=0', 'REFUSED:42501 -> fa=0 q=0', proof.ins('anon','u1','q16', :'text_html_q9', 5.00, 750.00));
SELECT proof.rec('F11 client writes the quarantine table directly', 'REFUSED:42P01', 'REFUSED:42501', proof.cs('authenticated','u1','INSERT INTO public.fee_acceptance_quarantine(reasons) VALUES (ARRAY[''x''])'), 'REFUSED:42501');
SELECT proof.rec('F12 client calls the quarantine writer outside the trigger', 'REFUSED:42883', 'REFUSED:42501', proof.cs('authenticated','u1','SELECT public.fee_acceptance_quarantine_add(NULL::public.fee_acceptances, ARRAY[''x''], 5, 5)'));
SELECT proof.rec('F13 client reads the quarantine table', 'REFUSED:42P01', 'REFUSED:42501', proof.cs('authenticated','u1','SELECT count(*) FROM public.fee_acceptance_quarantine'), 'REFUSED:42501');

-- ======================= LEGAL-READ 6668344412: the screen and the server disagree. The record must be KEPT, and must not reach the webhook =======================
SELECT proof.cq('l1','u3',15000);
SELECT proof.rec('L1a state-specific config row: server bid fee', 'pct=7.00 fee=1050.00', 'pct=7.00 fee=1050.00', proof.qfee('l1'));
SELECT proof.rec('L1b the form (reads contractors.state, sees only the 5% row) shows $750.00 at 5.00%', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u3','l1', :'text_html_q9', 5.00, 750.00));
SELECT proof.rec('L1c what was shown is kept', 'no quarantine table', 'shown=$750.00 client_fee=750.00 server=1050.00 pct=7.00', proof.held('l1'), 'no held row');
SELECT proof.rec('L1d webhook row choice for that claim (old query)', 'fee_amount=750.00', 'no row', proof.wh_old('l1'));
SELECT proof.rec('L2 stale keystroke refresh: contractor saw $75.00 on a $15,000 bid', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','q23', replace(:'text_html_q9','$750.00','$75.00'), 5.00, 75.00));
SELECT proof.rec('L2b L2 kept', 'no quarantine table', 'shown=$75.00 client_fee=75.00 server=750.00 pct=5.00', proof.held('q23'), 'no held row');

-- ======================= REVIEW 6668449870 B1: a second bid, and a price dip, each with a row that is true at its own instant =======================
SELECT proof.cq('s1a','u1',15000);
SELECT proof.rec('S1a genuine $15,000 bid + acceptance', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','s1a', :'text_html_q9', 5.00, 750.00));
UPDATE public.quotes SET status = 'selected' WHERE id = (SELECT quote_id FROM proof.q WHERE label = 's1a');
SELECT proof.cq('s1b','u1',1,'s1a');
SELECT proof.rec('S1b second bid at $1 (server fee 0.05) + its true acceptance', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','s1b', replace(:'text_html_q9','$750.00','$0.05'), 5.00, 0.05));
SELECT proof.rec('S1c webhook OLD query (claim + contractor, newest)', 'fee_amount=0.05', 'fee_amount=0.05', proof.wh_old('s1a'));
SELECT proof.rec('S1d webhook NEW: selected bid''s row', 'fee_amount=750.00', 'fee_amount=750.00', proof.wh_new('s1a'));
SELECT proof.cq('s2','u1',1);
SELECT proof.rec('S2a bid born at $1 + its true acceptance', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','s2', replace(:'text_html_q9','$750.00','$0.05'), 5.00, 0.05));
SELECT proof.cs('authenticated','u1',format('UPDATE public.quotes SET total_price = 15000 WHERE id = %L', (SELECT quote_id FROM proof.q WHERE label='s2')));
UPDATE public.quotes SET status = 'selected' WHERE id = (SELECT quote_id FROM proof.q WHERE label = 's2');
SELECT proof.rec('S2b bid fee after the contractor raised the price', 'pct=5.00 fee=750.00', 'pct=5.00 fee=750.00', proof.qfee('s2'));
SELECT proof.rec('S2c webhook OLD query', 'fee_amount=0.05', 'fee_amount=0.05', proof.wh_old('s2'));
SELECT proof.rec('S2d webhook NEW: row fee differs from the bid''s fee, so not evidence', 'not evidence: row fee 0.05 differs from bid fee 750.00', 'not evidence: row fee 0.05 differs from bid fee 750.00', proof.wh_new('s2'));
SELECT proof.cq('s3','u1',15000);
SELECT proof.cs('authenticated','u1',format('UPDATE public.quotes SET total_price = 1 WHERE id = %L', (SELECT quote_id FROM proof.q WHERE label='s3')));
SELECT proof.rec('S3a acceptance while the bid sits at $1', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','s3', replace(:'text_html_q9','$750.00','$0.05'), 5.00, 0.05));
SELECT proof.cs('authenticated','u1',format('UPDATE public.quotes SET total_price = 15000 WHERE id = %L', (SELECT quote_id FROM proof.q WHERE label='s3')));
UPDATE public.quotes SET status = 'selected' WHERE id = (SELECT quote_id FROM proof.q WHERE label = 's3');
SELECT proof.rec('S3b webhook OLD query', 'fee_amount=0.05', 'fee_amount=0.05', proof.wh_old('s3'));
SELECT proof.rec('S3c webhook NEW: not evidence', 'not evidence: row fee 0.05 differs from bid fee 750.00', 'not evidence: row fee 0.05 differs from bid fee 750.00', proof.wh_new('s3'));

-- ======================= THE WEBHOOK'S QUERY, forged newer row on the same bid =======================
SELECT proof.rec('W1 genuine acceptance, bid q15', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','q15', :'text_html_q9', 5.00, 750.00));
SELECT proof.rec('W2 forged newer row (fee 0.01, created_at +1h) for the same bid', 'ok -> fa=2 q=0', 'ok -> fa=1 q=1:displayed_fee_differs+duplicate_bid',
  proof.ins('authenticated','u1','q15', replace(replace(:'text_html_q9','$750.00','$0.01'),'(5.00%','(0.01%'), 0.01, 0.01, now(), now() + interval '1 hour'));
SELECT proof.rec('W3 webhook OLD query returns', 'fee_amount=0.01', 'fee_amount=750.00', proof.wh_old('q15'));

-- ======================= REVIEW 6669057587 B2: every key check pinned =======================
SELECT proof.rec('K1 React wording, fee $0.05 printed (both places) on a $750.00 bid', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k1', replace(:'text_react_q2','$750.00','$0.05'), 5.00, 750.00));
SELECT proof.rec('K2 React wording, rate 4.00% printed (both places)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k2', replace(:'text_react_q2','5.00%','4.00%'), 5.00, 750.00));
SELECT proof.rec('K3 React wording, wrong net amount', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k3', replace(:'text_react_q2','$14,250.00','$1.00'), 5.00, 750.00));
SELECT proof.rec('K4 React wording, the repeated figure differs from the first', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','k4', regexp_replace(:'text_react_q2', '\(\$750\.00\)$', '($1.00)'), 5.00, 750.00));
SELECT proof.rec('K5 HTML wording, rate 4.00% printed with the right fee', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k5', replace(:'text_html_q9','(5.00%','(4.00%'), 5.00, 750.00));
SELECT proof.rec('K6a HTML fee tolerance: $750.01 on a $750.00 fee is within a cent', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','k6a', replace(:'text_html_q9','$750.00','$750.01'), 5.00, 750.00));
SELECT proof.rec('K6b HTML fee tolerance: $750.02 is not', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k6b', replace(:'text_html_q9','$750.00','$750.02'), 5.00, 750.00));
SELECT proof.rec('K6c HTML fee tolerance: $760.00 is not', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k6c', replace(:'text_html_q9','$750.00','$760.00'), 5.00, 750.00));
SELECT proof.rec('K7 client-chosen fee_basis', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','k7', :'text_html_q9', 5.00, 750.00, p_basis => 'evil_basis'));
SELECT proof.rec('K7b K7 stored basis', 'fee_pct=5.00 fee_amount=750.00 basis=evil_basis', 'fee_pct=5.00 fee_amount=750.00 basis=bid_amount', proof.stored('k7','fee'));
SELECT proof.rec('K9 accepted_at one day in the future', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','k9', :'text_html_q9', 5.00, 750.00, now() + interval '1 day'));
SELECT proof.rec('K9b K9 accepted_at', 'client time kept', 'server time', proof.stored('k9','accepted_at'));
SELECT proof.rec('K10 a diverted row (accepted_at 2020, own id, own created_at) is kept exactly as sent', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs',
  proof.ins('authenticated','u1','k10', replace(:'text_html_q9','$750.00','$75.00'), 5.00, 75.00, '2020-01-01 00:00:00+00', '2021-02-03 04:05:06+00', p_id => '00000000-0000-4000-8000-00000000aaaa'));
SELECT proof.rec('K10b K10 as stored in quarantine', 'no quarantine table', 'accepted_at=as sent id=as sent created_at=as sent',
  proof.held_as_sent('k10', '00000000-0000-4000-8000-00000000aaaa', '2020-01-01 00:00:00+00', '2021-02-03 04:05:06+00'), 'no held row');
SELECT proof.rec('K12 junk text of 5000 characters is kept, capped at 4000', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','k12', repeat('x', 5000), 5.00, 750.00));
SELECT proof.rec('K12b K12 stored length (original length is recorded beside it)', 'no quarantine table', 'stored=4000 original=5000', proof.held_len('k12'), 'no held row');
SELECT proof.rec('K13 flood: one session diverts 30 rows; the cap is 25 an hour', 'no quarantine table', 'quarantine rows=25', proof.flood('u2', 30), 'quarantine rows=0');
SELECT proof.rec('K14 React wording, net amount $1.00 off (tolerance is two cents)', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:displayed_fee_differs', proof.ins('authenticated','u1','k14', replace(:'text_react_q2','$14,250.00','$14,249.00'), 5.00, 750.00));
SELECT proof.rec('K15 React wording, net amount two cents off is within tolerance', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','k15', replace(:'text_react_q2','$14,250.00','$14,250.02'), 5.00, 750.00));
SELECT proof.rec('K16 a 600-character user agent on a diverted row is kept, capped at 500', 'ok -> fa=1 q=0', 'ok -> fa=0 q=1:text_not_form_wording', proof.ins('authenticated','u1','k16', 'junk', 5.00, 750.00, p_ua => repeat('u', 600)));
SELECT proof.rec('K16b K16 stored user agent length', 'no quarantine table', 'ua=500', proof.held_ua_len('k16'), 'no held row');
SELECT proof.rec('K17 genuine insert with no IP (the lookup failed; the forms now send null)', 'ok -> fa=1 q=0', 'ok -> fa=1 q=0', proof.ins('authenticated','u1','k17', :'text_html_q9', 5.00, 750.00, p_ip => NULL));
SELECT proof.rec('K18 the string unknown as ip_address (the old forms) is refused by the inet type before any trigger runs: nothing is recorded or kept', 'REFUSED:22P02 -> fa=0 q=0', 'REFUSED:22P02 -> fa=0 q=0', proof.ins('authenticated','u1','k18', :'text_html_q9', 5.00, 750.00, p_ip => 'unknown'));
SELECT proof.rec('K19 service_role holds only SELECT and INSERT on the quarantine table (default ACLs grant it everything)', 'no quarantine table', 'INSERT,SELECT', proof.svc_privs(), 'INSERT,SELECT');

-- ======================= STATE =======================
SELECT proof.rec('S1 non-internal triggers on fee_acceptances', '0', '1', (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal));
SELECT proof.rec('S2 policies on fee_acceptances (unchanged by this file)', CASE current_setting('proof.composed') WHEN '1' THEN '3' ELSE '4' END, CASE current_setting('proof.composed') WHEN '1' THEN '3' ELSE '4' END, (SELECT count(*)::text FROM pg_policies WHERE tablename = 'fee_acceptances'));
SELECT proof.rec('S3 authenticated UPDATE,DELETE privilege (unchanged by this file; #3406 owns that)', CASE current_setting('proof.composed') WHEN '1' THEN 'false,false' ELSE 'true,true' END, CASE current_setting('proof.composed') WHEN '1' THEN 'false,false' ELSE 'true,true' END,
  has_table_privilege('authenticated','public.fee_acceptances','UPDATE') || ',' || has_table_privilege('authenticated','public.fee_acceptances','DELETE'));
SELECT proof.rec('S4 client privileges on the quarantine table (any of SELECT, INSERT, UPDATE, DELETE)', 'absent', 'false,false',
  CASE WHEN to_regclass('public.fee_acceptance_quarantine') IS NULL THEN 'absent' ELSE has_table_privilege('anon','public.fee_acceptance_quarantine','SELECT,INSERT,UPDATE,DELETE') || ',' || has_table_privilege('authenticated','public.fee_acceptance_quarantine','SELECT,INSERT,UPDATE,DELETE') END, 'false,false');

\o
SELECT 'PROOF|' || current_setting('proof.phase') || '|' || case_name || '|expected=' || expected || '|actual=' || actual || '|' || CASE WHEN ok THEN 'OK' ELSE 'FAIL' END FROM proof.res ORDER BY ord;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof.res;
ROLLBACK;
