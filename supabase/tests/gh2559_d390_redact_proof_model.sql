-- gh-2559 / D-390 proof MODEL (throwaway Postgres only; never production). Minimal model of claims, contractors, quotes, messages, profiles with the
-- policies as they will be AFTER PR #2777, the APPLIED bidder view run verbatim (ledger 20261008231303), and t.run_phase(), which probes every
-- reader and writes one row per probe into t.results. Fixtures are made-up. Probe output never prints a value: it prints booleans (has_phone / has_email).
\set ON_ERROR_STOP on
DO $r$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE 'CREATE ROLE ' || r || ' NOLOGIN'; END IF; END LOOP; END $r$;
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid UNIQUE, status text, is_test boolean);
CREATE TABLE public.carrier_profiles (id uuid PRIMARY KEY, carrier_name text);
CREATE TABLE public.claims (
  acv_amount numeric, bid_window_expires_at timestamptz, carrier_id uuid, claim_number text, contractor_scope_summary text, created_at timestamptz,
  damage_type text, deductible_amount numeric, designer_manufacturer text, designer_product text, estimate_filename text, existing_shingle_brand text,
  existing_shingle_color text, funding_type text, gutters_bid_released_at timestamptz, has_estimate boolean, has_measurements boolean, homeowner_name text,
  homeowner_notes text, hover_measurements jsonb, id uuid PRIMARY KEY, impact_class text, is_test boolean, job_type text, material_category text,
  measurement_shape text, measurements_filename text, parsed_line_items jsonb, property_address text, property_city text, property_zip text,
  rcv_amount numeric, ready_for_bids boolean, repair_squares numeric, roof_squares numeric, roofing_bid_released_at timestamptz,
  selected_contractor_id uuid, shingle_type text, siding_bid_released_at timestamptz, status text, trades text[], urgency text, urgency_deadline timestamptz,
  urgency_reason text, user_id uuid, windows_bid_released_at timestamptz,
  platform_fee_charged boolean DEFAULT false, contractor_switched_at timestamptz, contractor_released_at timestamptz);
CREATE TABLE public.quotes (claim_id uuid, contractor_id uuid);
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles(id),
  sender_role text NOT NULL CHECK (sender_role IN ('homeowner','contractor')),
  body text NOT NULL CHECK (char_length(body) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz);
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY c_own ON public.contractors FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY q_own ON public.quotes FOR SELECT USING (contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (SELECT auth.uid())));
CREATE POLICY cl_owner ON public.claims FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY cl_selected ON public.claims FOR SELECT USING (selected_contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (SELECT auth.uid()))
                                                          AND id IN (SELECT claim_id FROM public.quotes WHERE contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (SELECT auth.uid()))));
-- messages policies as in PR #2777 (head 1d7e1c0c)
CREATE POLICY contractor_messages_select ON public.messages FOR SELECT USING (
  claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
  AND EXISTS (SELECT 1 FROM claims WHERE claims.id = messages.claim_id AND claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid))
              AND (coalesce(claims.contractor_released_at, claims.contractor_switched_at) IS NULL OR messages.created_at >= coalesce(claims.contractor_released_at, claims.contractor_switched_at))));
CREATE POLICY contractor_messages_insert ON public.messages FOR INSERT WITH CHECK (
  sender_id = (SELECT auth.uid() AS uid) AND sender_role = 'contractor'
  AND claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
  AND claim_id IN (SELECT claims.id FROM claims WHERE claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid))));
CREATE POLICY homeowner_messages_select ON public.messages FOR SELECT USING (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)));
CREATE POLICY homeowner_messages_insert ON public.messages FOR INSERT WITH CHECK (
  sender_id = (SELECT auth.uid() AS uid) AND sender_role = 'homeowner' AND claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)));
CREATE POLICY service_role_messages ON public.messages USING (auth.role() = 'service_role');

-- the APPLIED bidder view, verbatim (BEGIN/COMMIT lines dropped by the runner into this file's \i source)
\i /tmp/d390_applied_view.sql

-- fixtures (fixed made-up ids). H homeowner; KS selected contractor; KB bidder (quote, not selected); KX no quote.
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-0000000000a1','Hannah Homeowner'),('00000000-0000-0000-0000-0000000000b1','Sam Selected'),
  ('00000000-0000-0000-0000-0000000000c1','Bea Bidder'),('00000000-0000-0000-0000-0000000000d1','Xan Xtra');
INSERT INTO public.contractors VALUES
 ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b1','active',false),
 ('10000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c1','active',false),
 ('10000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d1','active',false);
-- C1 selected, fee NOT charged; C2 selected, fee charged; C3 open for bids (bidder KB and KS both bid), not selected
INSERT INTO public.claims (id, user_id, ready_for_bids, status, is_test, job_type, homeowner_name, claim_number, homeowner_notes, selected_contractor_id, platform_fee_charged, property_address) VALUES
 ('20000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1',true,'bidding',false,'insurance_rcv',NULL,NULL,'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.','10000000-0000-0000-0000-0000000000b1',false,'1 Test Way, Carmel, IN 46032'),
 ('20000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000a1',true,'bidding',false,'insurance_rcv',NULL,NULL,'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.','10000000-0000-0000-0000-0000000000b1',true,'2 Test Way, Carmel, IN 46032'),
 ('20000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000a1',true,'bidding',false,'insurance_rcv',NULL,NULL,'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.',NULL,false,'3 Test Way, Carmel, IN 46032');
INSERT INTO public.quotes VALUES
 ('20000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000b1'),
 ('20000000-0000-0000-0000-0000000000c2','10000000-0000-0000-0000-0000000000b1'),
 ('20000000-0000-0000-0000-0000000000c3','10000000-0000-0000-0000-0000000000b1'),
 ('20000000-0000-0000-0000-0000000000c3','10000000-0000-0000-0000-0000000000c1'),
 ('20000000-0000-0000-0000-0000000000c1','10000000-0000-0000-0000-0000000000c1');
INSERT INTO public.messages (claim_id, sender_id, sender_role, body, created_at) VALUES
 ('20000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','homeowner','my cell is (317) 555-0142 and my mail is zelda.q@example.invalid, thanks','2026-01-01 10:00+00'),
 ('20000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','contractor','Contractor line is 317-555-0999 for scheduling','2026-01-01 10:05+00'),
 ('20000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000a1','homeowner','my cell is (317) 555-0142 and my mail is zelda.q@example.invalid, thanks','2026-01-01 10:00+00'),
 ('20000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b1','contractor','Contractor line is 317-555-0999 for scheduling','2026-01-01 10:05+00');

CREATE SCHEMA t;
CREATE TABLE t.results (phase text, probe text, detail text, ok boolean);
CREATE TABLE t.snap (k text PRIMARY KEY, v text);
GRANT USAGE ON SCHEMA t TO authenticated, anon, service_role;

-- helper: run a query as a role + user and return its text (a single scalar), under the same settings PostgREST uses
CREATE FUNCTION t.as_user(p_role text, p_uid text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid,''), true);
  PERFORM set_config('request.jwt.claim.role', p_role, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR:' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN v;
END $f$;

CREATE FUNCTION t.flags(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL THEN 'null' WHEN p LIKE 'ERR:%' THEN p
              ELSE 'has_phone=' || (p ~ '555-?\s?0142|\(317\)\s*555')::text || ',has_email=' || (p ~ 'zelda\.q@example')::text END $$;

-- t.run_phase(phase, mode): mode 'live' = old behaviour expected, 'new' = D-390 behaviour expected.
CREATE FUNCTION t.run_phase(p_phase text, p_mode text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  H text := '00000000-0000-0000-0000-0000000000a1'; KS text := '00000000-0000-0000-0000-0000000000b1';
  KB text := '00000000-0000-0000-0000-0000000000c1'; KX text := '00000000-0000-0000-0000-0000000000d1';
  C1 text := '20000000-0000-0000-0000-0000000000c1'; C2 text := '20000000-0000-0000-0000-0000000000c2'; C3 text := '20000000-0000-0000-0000-0000000000c3';
  got text; exp text; thread_exists boolean := (to_regclass('public.contractor_thread_messages') IS NOT NULL); snap text;
BEGIN
  -- P01 selected contractor, SOW-notes surface via the bidder view, fee NOT charged
  got := t.flags(t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C1)));
  exp := CASE p_mode WHEN 'live' THEN 'has_phone=true,has_email=true' ELSE 'has_phone=false,has_email=false' END;
  INSERT INTO t.results VALUES (p_phase, 'P01 selected contractor, view notes, pre-fee', got, got = exp);
  -- P02 same, fee charged: always as typed
  got := t.flags(t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C2)));
  INSERT INTO t.results VALUES (p_phase, 'P02 selected contractor, view notes, post-fee', got, got = 'has_phone=true,has_email=true');
  -- P03 homeowner always reads her own text (base row)
  got := t.flags(t.as_user('authenticated', H, format($q$SELECT homeowner_notes FROM public.claims WHERE id = %L$q$, C1)));
  INSERT INTO t.results VALUES (p_phase, 'P03 homeowner, base notes, pre-fee', got, got = 'has_phone=true,has_email=true');
  -- P04 bidders unchanged: the bidder's view text on C3 (and the non-selected KS on C3) is byte-identical to the LIVE snapshot
  got := t.as_user('authenticated', KB, format($q$SELECT md5(coalesce(homeowner_notes,'<null>')) FROM public.bidder_claim_summary WHERE id = %L$q$, C3));
  IF p_phase = '1-live' THEN INSERT INTO t.snap VALUES ('bidder_c3', got); END IF;
  SELECT v INTO snap FROM t.snap WHERE k = 'bidder_c3';
  INSERT INTO t.results VALUES (p_phase, 'P04 bidder KB, view notes C3, md5 equals LIVE', CASE WHEN got = snap THEN 'same' ELSE 'DIFFERENT' END, got = snap);
  got := t.flags(t.as_user('authenticated', KB, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C3)));
  INSERT INTO t.results VALUES (p_phase, 'P04b bidder KB, view notes C3', got, got = 'has_phone=false,has_email=false');
  got := t.flags(t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C3)));
  INSERT INTO t.results VALUES (p_phase, 'P04c KS as plain bidder on C3, view notes', got, got = 'has_phone=false,has_email=false');
  -- P05 thread view, selected contractor, homeowner message, pre-fee
  IF thread_exists THEN
    got := t.flags(t.as_user('authenticated', KS, format($q$SELECT body FROM public.contractor_thread_messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C1)));
    INSERT INTO t.results VALUES (p_phase, 'P05 selected contractor, thread view, homeowner msg pre-fee', got, got = 'has_phone=false,has_email=false');
    got := t.as_user('authenticated', KS, format($q$SELECT body FROM public.contractor_thread_messages WHERE claim_id = %L AND sender_role = 'contractor'$q$, C1));
    INSERT INTO t.results VALUES (p_phase, 'P05b thread view, contractor-sent msg stays as typed (own phone kept)', CASE WHEN got LIKE '%317-555-0999%' THEN 'kept' ELSE 'REMOVED' END, got LIKE '%317-555-0999%');
    got := t.flags(t.as_user('authenticated', KS, format($q$SELECT body FROM public.contractor_thread_messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C2)));
    INSERT INTO t.results VALUES (p_phase, 'P06 selected contractor, thread view, homeowner msg post-fee', got, got = 'has_phone=true,has_email=true');
    got := t.as_user('authenticated', KB, format($q$SELECT count(*)::text FROM public.contractor_thread_messages WHERE claim_id = %L$q$, C1));
    INSERT INTO t.results VALUES (p_phase, 'P07 non-selected bidder KB, thread view rows on C1', got, got = '0');
    got := t.as_user('authenticated', KX, format($q$SELECT count(*)::text FROM public.contractor_thread_messages$q$));
    INSERT INTO t.results VALUES (p_phase, 'P07b contractor with no quote, thread view rows', got, got = '0');
    got := t.as_user('authenticated', H, format($q$SELECT count(*)::text FROM public.contractor_thread_messages$q$));
    INSERT INTO t.results VALUES (p_phase, 'P07c homeowner through contractor view (not a contractor)', got, got = '0');
  ELSE
    INSERT INTO t.results VALUES (p_phase, 'P05-P07 thread view absent in this phase', 'absent', p_mode = 'live');
  END IF;
  -- P08 base table as the selected contractor (the PostgREST bypass): homeowner-sent rows
  got := t.as_user('authenticated', KS, format($q$SELECT count(*)::text FROM public.messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C1));
  exp := CASE p_mode WHEN 'live' THEN '1' ELSE '0' END;
  INSERT INTO t.results VALUES (p_phase, 'P08 selected contractor, base messages, homeowner rows pre-fee', got, got = exp);
  got := t.as_user('authenticated', KS, format($q$SELECT count(*)::text FROM public.messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C2));
  INSERT INTO t.results VALUES (p_phase, 'P08b selected contractor, base messages, homeowner rows post-fee', got, got = '1');
  got := t.as_user('authenticated', KS, format($q$SELECT count(*)::text FROM public.messages WHERE claim_id = %L AND sender_role = 'contractor'$q$, C1));
  INSERT INTO t.results VALUES (p_phase, 'P08c selected contractor, base messages, own rows pre-fee', got, got = '1');
  -- P09 homeowner reads both rows as typed
  got := t.as_user('authenticated', H, format($q$SELECT count(*)::text FROM public.messages WHERE claim_id = %L$q$, C1));
  INSERT INTO t.results VALUES (p_phase, 'P09 homeowner, base messages C1, rows', got, got = '2');
  got := t.flags(t.as_user('authenticated', H, format($q$SELECT body FROM public.messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C1)));
  INSERT INTO t.results VALUES (p_phase, 'P09b homeowner, own message as typed', got, got = 'has_phone=true,has_email=true');
  -- P10 non-selected bidder, base messages
  got := t.as_user('authenticated', KB, format($q$SELECT count(*)::text FROM public.messages WHERE claim_id = %L$q$, C1));
  INSERT INTO t.results VALUES (p_phase, 'P10 non-selected bidder, base messages C1', got, got = '0');
  -- P11 writes still work: selected contractor INSERT .. RETURNING, homeowner INSERT .. RETURNING
  got := t.as_user('authenticated', KS, format($q$WITH i AS (INSERT INTO public.messages (claim_id, sender_id, sender_role, body) VALUES (%L, %L, 'contractor', 'ok') RETURNING id) SELECT count(*)::text FROM i$q$, C1, KS));
  INSERT INTO t.results VALUES (p_phase, 'P11 selected contractor INSERT .. RETURNING', got, got = '1');
  got := t.as_user('authenticated', H, format($q$WITH i AS (INSERT INTO public.messages (claim_id, sender_id, sender_role, body) VALUES (%L, %L, 'homeowner', 'ok') RETURNING id) SELECT count(*)::text FROM i$q$, C1, H));
  INSERT INTO t.results VALUES (p_phase, 'P12 homeowner INSERT .. RETURNING', got, got = '1');
  DELETE FROM public.messages WHERE body = 'ok';
  -- P13 service role reads as typed
  got := t.flags(t.as_user('service_role', NULL, format($q$SELECT body FROM public.messages WHERE claim_id = %L AND sender_role = 'homeowner'$q$, C1)));
  INSERT INTO t.results VALUES (p_phase, 'P13 service_role, base messages homeowner row', got, got = 'has_phone=true,has_email=true');
  -- P14 RESIDUAL (not closed here, stated): the selected contractor reading the BASE claims row
  got := t.flags(t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.claims WHERE id = %L$q$, C1)));
  INSERT INTO t.results VALUES (p_phase, 'P14 RESIDUAL selected contractor, BASE claims notes pre-fee (documented, still as typed)', got, got = 'has_phone=true,has_email=true');
  -- P15 function privileges
  IF to_regprocedure('public.d390_redact_contact(text)') IS NOT NULL THEN
    INSERT INTO t.results VALUES (p_phase, 'P15 execute anon / authenticated / service_role (false/true/true expected)',
       has_function_privilege('anon','public.d390_redact_contact(text)','EXECUTE')::text || '/' || has_function_privilege('authenticated','public.d390_redact_contact(text)','EXECUTE')::text || '/' || has_function_privilege('service_role','public.d390_redact_contact(text)','EXECUTE')::text,
       NOT has_function_privilege('anon','public.d390_redact_contact(text)','EXECUTE') AND has_function_privilege('authenticated','public.d390_redact_contact(text)','EXECUTE') AND has_function_privilege('service_role','public.d390_redact_contact(text)','EXECUTE'));
  END IF;
END $f$;
