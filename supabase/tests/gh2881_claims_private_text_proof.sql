-- gh-2881 PROOF: a contractor (selected or not) cannot read homeowner-typed text from the base claims row by a direct request; the homeowner
-- (via the owner RPC), service_role and the other columns are unaffected. Runs in BEGIN ... ROLLBACK: nothing persists.
-- Psql script (uses \i for the forward file). Stage markers are printed as NOTICE lines starting "PROOF".
-- Fixtures are looked up (is_test claim with a selected contractor, a second contractor with a quote, an unrelated contractor) so the same file
-- runs on the throwaway model and, read by a human, against production inside the same rolled-back block. The probe text is written INSIDE the
-- transaction (triggers off for that one UPDATE) so an is_test claim with empty notes still shows the leak.
--   run it with supabase/tests/gh2881_claims_private_text_proof_run.sh (throwaway Postgres only)
\set QUIET on
SET client_min_messages = notice;
BEGIN;
CREATE TEMP TABLE _fx (k text PRIMARY KEY, v text);
GRANT ALL ON _fx TO PUBLIC;
DO $fx$
DECLARE v_claim uuid; v_owner uuid; v_sel uuid; v_selu uuid; v_b uuid; v_bu uuid; v_n uuid; v_nu uuid;
BEGIN
  SELECT c.id, c.user_id, c.selected_contractor_id INTO v_claim, v_owner, v_sel
    FROM public.claims c WHERE c.is_test = true AND c.selected_contractor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = c.id AND q.contractor_id = c.selected_contractor_id)
   ORDER BY c.created_at LIMIT 1;
  IF v_claim IS NULL THEN RAISE EXCEPTION 'PROOF FIXTURE: no is_test claim with a selected contractor holding a quote'; END IF;
  SELECT user_id INTO v_selu FROM public.contractors WHERE id = v_sel;
  SELECT k.id, k.user_id INTO v_b, v_bu FROM public.contractors k WHERE k.is_test = true AND k.status = 'active' AND k.id <> v_sel AND k.user_id NOT IN (v_owner, v_selu)
     AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = v_claim AND q.contractor_id = k.id) ORDER BY k.id LIMIT 1;
  SELECT k.id, k.user_id INTO v_n, v_nu FROM public.contractors k WHERE k.is_test = true AND k.status = 'active' AND k.id NOT IN (v_sel, coalesce(v_b, v_sel)) AND k.user_id NOT IN (v_owner, v_selu, coalesce(v_bu, v_selu))
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = v_claim AND q.contractor_id = k.id) ORDER BY k.id LIMIT 1;
  IF v_b IS NULL OR v_n IS NULL THEN RAISE EXCEPTION 'PROOF FIXTURE: need a non-selected bidder and a non-bidder is_test contractor'; END IF;
  INSERT INTO _fx VALUES ('claim', v_claim::text), ('owner', v_owner::text), ('sel', v_selu::text), ('bid', v_bu::text), ('non', v_nu::text);
  RAISE NOTICE 'PROOF fixtures: claim % is_test=% ; homeowner %, selected contractor %, non-selected bidder %, non-bidder % (digests, all different)',
    left(v_claim::text, 8), (SELECT is_test FROM public.claims WHERE id = v_claim), left(v_owner::text, 8), left(v_selu::text, 8), left(v_bu::text, 8), left(v_nu::text, 8);
END $fx$;

-- probe text, inside this transaction only
SET LOCAL session_replication_role = replica;
UPDATE public.claims SET homeowner_notes = 'PROBE call 317-555-0142 or probe@example.com',
                         urgency_reason = 'PROBE closing Friday',
                         project_confirmation = jsonb_build_object('homeownerNotes', 'PROBE gate 4412', 'workNotBeingDone', 'PROBE fence 317-555-0142')
 WHERE id = (SELECT v FROM _fx WHERE k = 'claim')::uuid;
SET LOCAL session_replication_role = origin;

-- one probe routine; returns one line per outcome. Runs the statement as the given role and user, and reports data or the SQLSTATE.
CREATE FUNCTION pg_temp.probe(p_label text, p_role text, p_uid text, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $p$
DECLARE v_out text; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_sql ILIKE 'WITH%' THEN EXECUTE p_sql INTO v_out;
    ELSE EXECUTE 'SELECT coalesce(string_agg(t::text, E''\n''), ''(no rows)'') FROM (' || p_sql || ') t' INTO v_out; END IF;
    RESET ROLE;
    RETURN format('%s => READ OK: %s', p_label, left(v_out, 150));
  EXCEPTION WHEN others THEN
    RESET ROLE;
    RETURN format('%s => REFUSED sqlstate=%s (%s)', p_label, SQLSTATE, left(SQLERRM, 80));
  END;
END $p$;
GRANT EXECUTE ON FUNCTION pg_temp.probe(text,text,text,text,text) TO PUBLIC;

CREATE FUNCTION pg_temp.run_probes(p_phase text) RETURNS void LANGUAGE plpgsql AS $r$
DECLARE c text := (SELECT v FROM _fx WHERE k='claim'); o text := (SELECT v FROM _fx WHERE k='owner'); s text := (SELECT v FROM _fx WHERE k='sel');
        b text := (SELECT v FROM _fx WHERE k='bid'); n text := (SELECT v FROM _fx WHERE k='non'); q text;
BEGIN
  q := format('SELECT homeowner_notes, urgency_reason, project_confirmation FROM public.claims WHERE id = %L', c);
  RAISE NOTICE 'PROOF[%] selected contractor, direct read of the 3 columns   %', p_phase, pg_temp.probe('selected', 'authenticated', s, 'sel@example.test', q);
  RAISE NOTICE 'PROOF[%] non-selected bidder, direct read of the 3 columns    %', p_phase, pg_temp.probe('bidder', 'authenticated', b, 'bid@example.test', q);
  RAISE NOTICE 'PROOF[%] selected contractor, project_confirmation only       %', p_phase, pg_temp.probe('selected-pc', 'authenticated', s, 'sel@example.test', format('SELECT project_confirmation FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] selected contractor, select * (all columns)          %', p_phase, pg_temp.probe('selected-star', 'authenticated', s, 'sel@example.test', format('SELECT * FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] selected contractor, the other columns the pages read %', p_phase, pg_temp.probe('selected-cols', 'authenticated', s, 'sel@example.test', format('SELECT id, status, property_address, selected_contractor_id FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] homeowner, direct read of homeowner_notes            %', p_phase, pg_temp.probe('owner', 'authenticated', o, 'owner@example.test', format('SELECT homeowner_notes FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] homeowner, other columns                             %', p_phase, pg_temp.probe('owner-cols', 'authenticated', o, 'owner@example.test', format('SELECT id, status FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] service_role, read of the 3 columns                  %', p_phase, pg_temp.probe('service', 'service_role', o, 'svc@example.test', q);
  IF to_regprocedure('public.claim_private_text(uuid)') IS NOT NULL THEN
    RAISE NOTICE 'PROOF[%] homeowner, claim_private_text()                      %', p_phase, pg_temp.probe('owner-rpc', 'authenticated', o, 'owner@example.test', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
    RAISE NOTICE 'PROOF[%] selected contractor, claim_private_text()            %', p_phase, pg_temp.probe('sel-rpc', 'authenticated', s, 'sel@example.test', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
    RAISE NOTICE 'PROOF[%] non-selected bidder, claim_private_text()            %', p_phase, pg_temp.probe('bid-rpc', 'authenticated', b, 'bid@example.test', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
    RAISE NOTICE 'PROOF[%] non-bidder contractor, claim_private_text()          %', p_phase, pg_temp.probe('non-rpc', 'authenticated', n, 'non@example.test', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
    RAISE NOTICE 'PROOF[%] admin, claim_private_text()                          %', p_phase, pg_temp.probe('admin-rpc', 'authenticated', n, 'dustin@otterquote.com', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
    RAISE NOTICE 'PROOF[%] anon, claim_private_text()                           %', p_phase, pg_temp.probe('anon-rpc', 'anon', n, 'anon@example.test', format('SELECT * FROM public.claim_private_text(%L::uuid)', c));
  END IF;
  RAISE NOTICE 'PROOF[%] anon, direct read of homeowner_notes                 %', p_phase, pg_temp.probe('anon', 'anon', n, 'anon@example.test', format('SELECT homeowner_notes FROM public.claims WHERE id = %L', c));
  RAISE NOTICE 'PROOF[%] homeowner, UPDATE homeowner_notes (write path)        %', p_phase, pg_temp.probe('owner-write', 'authenticated', o, 'owner@example.test', format('WITH u AS (UPDATE public.claims SET homeowner_notes = ''PROBE call 317-555-0142 or probe@example.com'' WHERE id = %L RETURNING id) SELECT coalesce(string_agg(u.id::text, '',''), ''(no rows)'') FROM u', c));
END $r$;

-- ===== BEFORE: today's schema (NEGATIVE CONTROL: the contractor read must SUCCEED here) =====
DO $b$ BEGIN PERFORM pg_temp.run_probes('BEFORE'); END $b$;

-- ===== APPLY the forward file, with the operator's gate statement =====
SET LOCAL gh2881.pages_published = 'yes';
-- :fwd is the forward file with its own BEGIN/COMMIT lines removed (the runner makes it), so it runs inside this rolled-back block
\i :fwd

-- ===== AFTER =====
DO $a$ BEGIN PERFORM pg_temp.run_probes('AFTER'); END $a$;

DO $c$ BEGIN
  RAISE NOTICE 'PROOF[AFTER] ACL check: authenticated INSERT/UPDATE on claims unchanged: insert=% update=%',
    has_table_privilege('authenticated','public.claims','INSERT'), has_table_privilege('authenticated','public.claims','UPDATE');
  RAISE NOTICE 'PROOF[AFTER] ACL check: column privilege homeowner_notes: authenticated=% anon=% service_role=%',
    has_column_privilege('authenticated','public.claims','homeowner_notes','SELECT'), has_column_privilege('anon','public.claims','homeowner_notes','SELECT'), has_column_privilege('service_role','public.claims','homeowner_notes','SELECT');
END $c$;
ROLLBACK;
\echo PROOF: rolled back
