-- gh-3409 proof, run by gh3409_fee_acceptances_client_insert_guard_proof_run.sh on a THROWAWAY Postgres (schema: gh3409_throwaway_schema.sql). Never run against production.
-- psql -v phase=before|after -f texts.psql -f this_file. `before` = today's behaviour (negative control: forged inserts SUCCEED); `after` = with the forward file applied.
-- Everything is inside BEGIN ... ROLLBACK, so every phase starts from an empty database. Output: PROOF|phase|case|expected|actual|OK/FAIL ... then FAILING=n of m.
\set ON_ERROR_STOP on
\if :{?composed}
\else
\set composed 0
\endif
-- composed=1: PR #3406 (gh-3320) is also applied, so S2/S3 expect its effect (3 policies, no client UPDATE/DELETE); every other case is identical
\pset format unaligned
\pset tuples_only on
BEGIN;
\o /dev/null
SELECT set_config('proof.phase', :'phase', false), set_config('proof.composed', :'composed', false);
CREATE SCHEMA proof;
CREATE TABLE proof.q (label text PRIMARY KEY, quote_id uuid, claim_id uuid, contractor_id uuid);
CREATE TABLE proof.res (ord serial, case_name text, expected text, actual text, ok boolean);
CREATE TABLE proof.people (who text PRIMARY KEY, user_id uuid, contractor_id uuid);
INSERT INTO proof.people SELECT 'u1', gen_random_uuid(), gen_random_uuid() UNION ALL SELECT 'u2', gen_random_uuid(), gen_random_uuid();
INSERT INTO public.contractors (id, user_id) SELECT contractor_id, user_id FROM proof.people;
-- a seeded bid: fee server-set as gh-2519 does (rate 5.00, fee = round(total*5/100, 2)); age in hours
CREATE FUNCTION proof.mk(p_label text, p_who text, p_total numeric, p_status text DEFAULT 'submitted', p_age_h numeric DEFAULT 0) RETURNS void LANGUAGE plpgsql AS $m$
DECLARE c uuid := gen_random_uuid(); qid uuid := gen_random_uuid(); k uuid;
BEGIN
  SELECT contractor_id INTO k FROM proof.people WHERE who = p_who;
  INSERT INTO public.claims(id) VALUES (c);
  INSERT INTO public.quotes(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, created_at, platform_fee_pct, platform_fee_basis)
    VALUES (qid, c, k, p_total, 5.00, round(p_total * 5.00 / 100, 2), p_status, now() - (p_age_h || ' hours')::interval, 5.00, 'bid_amount');
  INSERT INTO proof.q VALUES (p_label, qid, c, k);
END $m$;
SELECT proof.mk('q1','u1',18500); SELECT proof.mk('q2','u1',15000); SELECT proof.mk('q3','u1',4000,'submitted',24); SELECT proof.mk('q4','u2',9000);
SELECT proof.mk('q5','u1',15000,'selected'); SELECT proof.mk('q6','u1',12345.50); SELECT proof.mk('q6b','u1',12345.50); SELECT proof.mk('q7','u1',15000);
SELECT proof.mk('q8','u1',15000); SELECT proof.mk('q9','u1',15000); SELECT proof.mk('q10','u1',15000); SELECT proof.mk('q11','u1',15000);
SELECT proof.mk('q12','u1',15000); SELECT proof.mk('q13','u1',15000); SELECT proof.mk('q14','u1',15000); SELECT proof.mk('q15','u1',15000);
SELECT proof.mk('q16','u1',15000); SELECT proof.mk('q17','u1',15000); SELECT proof.mk('q18','u1',4000,'submitted',24);

-- one INSERT as a given role; returns ok or REFUSED:<sqlstate>. Default identity is the bid's own contractor.
CREATE FUNCTION proof.ins(p_role text, p_who text, p_label text, p_text text, p_pct numeric, p_fee numeric,
  p_accepted timestamptz DEFAULT now(), p_created timestamptz DEFAULT NULL, p_invoice text DEFAULT NULL, p_resc timestamptz DEFAULT NULL,
  p_claim_label text DEFAULT NULL, p_contractor_who text DEFAULT NULL, p_bid uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $i$
DECLARE qr proof.q; cr proof.q; uid uuid; cid uuid; claim uuid; bid uuid;
BEGIN
  SELECT * INTO qr FROM proof.q WHERE label = p_label;
  SELECT user_id INTO uid FROM proof.people WHERE who = p_who;
  SELECT contractor_id INTO cid FROM proof.people WHERE who = COALESCE(p_contractor_who, p_who);
  claim := COALESCE((SELECT claim_id FROM proof.q WHERE label = p_claim_label), qr.claim_id);
  bid := COALESCE(p_bid, qr.quote_id);
  IF p_role = 'anon' THEN uid := NULL; END IF;   -- an anonymous JWT carries no sub
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', p_role, 'email', 'x@example.test')::text, true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent, created_at, invoice_url, rescinded_at)
    VALUES (cid, claim, bid, p_pct, 'bid_amount', p_fee, p_text, p_accepted, '203.0.113.7', 'UA/1.0', COALESCE(p_created, now()), p_invoice, p_resc);
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN 'REFUSED:' || SQLSTATE;
END $i$;
CREATE FUNCTION proof.rec(p_case text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $r$
  INSERT INTO proof.res(case_name, expected, actual, ok)
  SELECT p_case, e, p_actual, e = p_actual FROM (SELECT CASE current_setting('proof.phase') WHEN 'before' THEN p_before ELSE p_after END AS e) s $r$;
CREATE FUNCTION proof.stored(p_label text, p_what text) RETURNS text LANGUAGE plpgsql AS $s$
DECLARE f public.fee_acceptances;
BEGIN
  SELECT fa.* INTO f FROM public.fee_acceptances fa JOIN proof.q q ON q.quote_id = fa.bid_id WHERE q.label = p_label ORDER BY fa.created_at LIMIT 1;
  IF NOT FOUND THEN RETURN 'no row'; END IF;
  IF p_what = 'fee' THEN RETURN 'fee_pct=' || f.fee_pct || ' fee_amount=' || f.fee_amount || ' basis=' || f.fee_basis; END IF;
  IF p_what = 'accepted_at' THEN RETURN CASE WHEN abs(extract(epoch FROM f.accepted_at - now())) < 60 THEN 'server time' ELSE 'client time kept' END; END IF;
  IF p_what = 'server_cols' THEN RETURN 'created=' || CASE WHEN abs(extract(epoch FROM f.created_at - now())) < 60 THEN 'now' ELSE 'client-chosen' END
     || ' invoice=' || CASE WHEN f.invoice_url IS NULL THEN 'null' ELSE 'set' END || ' rescinded=' || CASE WHEN f.rescinded_at IS NULL THEN 'null' ELSE 'set' END; END IF;
  RETURN '?';
END $s$;
-- a server-side function owned by the table owner (SECURITY DEFINER), the shape of any future Edge-side or RPC writer
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
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RESET ROLE; RETURN 'REFUSED:' || SQLSTATE;
END $v$;
GRANT USAGE ON SCHEMA proof TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO authenticated, anon, service_role;
GRANT SELECT ON proof.q, proof.people TO authenticated, anon, service_role;

-- ======================= REAL ACCEPTANCE PATHS (must work in every phase) =======================
SELECT proof.rec('R1 HTML form insert (text rendered from contractor-bid-form.html)', 'ok', 'ok', proof.ins('authenticated','u1','q1', :'text_html_q1', 5.00, 925.00));
SELECT proof.rec('R1b R1 stored fee equals the bid''s', 'fee_pct=5.00 fee_amount=925.00 basis=bid_amount', 'fee_pct=5.00 fee_amount=925.00 basis=bid_amount', proof.stored('q1','fee'));
SELECT proof.rec('R2 React form insert (text rendered from react-app copy.ts)', 'ok', 'ok', proof.ins('authenticated','u1','q2', :'text_react_q2', 5.00, 750.00));
SELECT proof.rec('R3 half-cent bid, HTML form float fee 617.275', 'ok', 'ok', proof.ins('authenticated','u1','q6', :'text_html_q6', 5.00, 617.275));
SELECT proof.rec('R3b half-cent bid, React form (net rounds a cent differently)', 'ok', 'ok', proof.ins('authenticated','u1','q6b', :'text_react_q6b', 5.00, 617.275));
SELECT proof.rec('R4 device clock 2h slow: row still recorded', 'ok', 'ok', proof.ins('authenticated','u1','q7', :'text_html_q7', 5.00, 750.00, now() - interval '2 hours'));
SELECT proof.rec('R4b R4 accepted_at', 'client time kept', 'server time', proof.stored('q7','accepted_at'));
SELECT proof.rec('R5 service_role insert (Edge Function / seed shape, any values)', 'ok', 'ok', proof.ins('service_role','u1','q18','anything at all', 1.00, 1.00));
SELECT proof.rec('R5b SECURITY DEFINER server-side function insert, any values', 'ok', 'ok', proof.via_definer('u1','q17'));

-- ======================= FORGERIES (today: succeed; after: refused or neutralised) =======================
SELECT proof.rec('F1a forged fee_pct/fee_amount, honest text: stored fee', 'ok', 'ok', proof.ins('authenticated','u1','q9', :'text_html_q9', 0.01, 0.01));
SELECT proof.rec('F1a stored fee_pct/fee_amount', 'fee_pct=0.01 fee_amount=0.01 basis=bid_amount', 'fee_pct=5.00 fee_amount=750.00 basis=bid_amount', proof.stored('q9','fee'));
SELECT proof.rec('F1b forged fee AND matching forged text ($0.01)', 'ok', 'REFUSED:42501',
  proof.ins('authenticated','u1','q10', replace(replace(:'text_html_q9','$750.00','$0.01'),'(5.00%','(0.01%'), 0.01, 0.01));
SELECT proof.rec('F2 honest numbers, chosen text', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q11', 'The contractor never agreed to any fee.', 5.00, 750.00));
SELECT proof.rec('F2b form text with a different dollar fee ($1.00)', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q12', replace(:'text_html_q9','$750.00','$1.00'), 5.00, 750.00));
SELECT proof.rec('F2c wording drift (one word of the form text changed; documented coupling)', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q13', :'text_html_drift', 5.00, 750.00));
SELECT proof.rec('F3 acceptance naming ANOTHER contractor''s bid', 'ok', 'REFUSED:42501',
  proof.ins('authenticated','u1','q4', replace(:'text_html_q9','$750.00','$450.00'), 5.00, 450.00, p_contractor_who => 'u1'));
SELECT proof.rec('F3b row naming another contractor as the acceptor (policy)', 'REFUSED:42501', 'REFUSED:42501',
  proof.ins('authenticated','u1','q4', replace(:'text_html_q9','$750.00','$450.00'), 5.00, 450.00, p_contractor_who => 'u2'));
SELECT proof.rec('F4 own bid but another claim_id', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q14', :'text_html_q9', 5.00, 750.00, p_claim_label => 'q2'));
SELECT proof.rec('F5 nonexistent bid_id', 'REFUSED:23503', 'REFUSED:42501', proof.ins('authenticated','u1','q14', :'text_html_q9', 5.00, 750.00, p_bid => gen_random_uuid()));
SELECT proof.rec('F6 second (newer) acceptance for a bid that already has one', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q1', :'text_html_q1', 5.00, 925.00));
SELECT proof.rec('F7 backdated acceptance for a 24h-old bid', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q3', replace(:'text_html_q9','$750.00','$200.00'), 5.00, 200.00));
SELECT proof.rec('F8 acceptance after the bid was selected', 'ok', 'REFUSED:42501', proof.ins('authenticated','u1','q5', :'text_html_q9', 5.00, 750.00));
SELECT proof.rec('F9 client sets created_at 2099, invoice_url, rescinded_at on a good insert', 'ok', 'ok',
  proof.ins('authenticated','u1','q8', :'text_html_q9', 5.00, 750.00, now(), '2099-01-01 00:00:00+00', 'https://example.test/x', now()));
SELECT proof.rec('F9b F9 stored created_at/invoice/rescinded', 'created=client-chosen invoice=set rescinded=set', 'created=now invoice=null rescinded=null', proof.stored('q8','server_cols'));
SELECT proof.rec('F10 anon insert', 'REFUSED:42501', 'REFUSED:42501', proof.ins('anon','u1','q16', :'text_html_q9', 5.00, 750.00));

-- ======================= THE WEBHOOK'S QUERY (stripe-webhook/index.ts:494-502) =======================
SELECT proof.rec('W1 genuine acceptance, claim q15', 'ok', 'ok', proof.ins('authenticated','u1','q15', :'text_html_q9', 5.00, 750.00));
SELECT proof.rec('W2 forged newer row (fee 0.01, created_at +1h) for the same claim', 'ok', 'REFUSED:42501',
  proof.ins('authenticated','u1','q15', replace(replace(:'text_html_q9','$750.00','$0.01'),'(5.00%','(0.01%'), 0.01, 0.01, now(), now() + interval '1 hour'));
SELECT proof.rec('W3 webhook query shape returns', 'fee_amount=0.01', 'fee_amount=750.00', (
  SELECT 'fee_amount=' || fa.fee_amount FROM public.fee_acceptances fa JOIN proof.q q ON q.claim_id = fa.claim_id AND q.contractor_id = fa.contractor_id
   WHERE q.label = 'q15' AND fa.rescinded_at IS NULL ORDER BY fa.created_at DESC LIMIT 1));

-- ======================= STATE =======================
SELECT proof.rec('S1 non-internal triggers on fee_acceptances', '0', '1', (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal));
SELECT proof.rec('S2 policies on fee_acceptances (unchanged by this file)', CASE current_setting('proof.composed') WHEN '1' THEN '3' ELSE '4' END, CASE current_setting('proof.composed') WHEN '1' THEN '3' ELSE '4' END, (SELECT count(*)::text FROM pg_policies WHERE tablename = 'fee_acceptances'));
SELECT proof.rec('S3 authenticated UPDATE,DELETE privilege (unchanged by this file; #3406 owns that)', CASE current_setting('proof.composed') WHEN '1' THEN 'false,false' ELSE 'true,true' END, CASE current_setting('proof.composed') WHEN '1' THEN 'false,false' ELSE 'true,true' END,
  has_table_privilege('authenticated','public.fee_acceptances','UPDATE') || ',' || has_table_privilege('authenticated','public.fee_acceptances','DELETE'));

\o
SELECT 'PROOF|' || current_setting('proof.phase') || '|' || case_name || '|expected=' || expected || '|actual=' || actual || '|' || CASE WHEN ok THEN 'OK' ELSE 'FAIL' END FROM proof.res ORDER BY ord;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof.res;
ROLLBACK;
