-- gh-3224 proof: the last admin verdict on a contractor template is durable (draft migration
-- supabase/migrations_drafts/gh3224_template_verdict_log.sql). Follows gh2997_inherit_is_test_proof.sql: one DO batch that
-- records every check in a temp table and ends in a deliberate RAISE EXCEPTION, so the batch rolls back and reports in the error text.
-- Run: bash supabase/tests/gh3224_template_verdict_log_proof_run.sh [--mutations]   (scratch Postgres; production is never written).
-- Run this file with psql --single-transaction (-1), as the runner does: the final RAISE then rolls back the fixtures too.
-- Production use (Tier 3B apply window, by the CTO, NOT done here): splice the migration body (without BEGIN/COMMIT) at @@MIGRATION@@
-- inside one transaction and run the DO batch; the fixtures below are created inside the batch and rolled back.
CREATE TEMP TABLE _r(k text, ok boolean, v text);
GRANT ALL ON _r TO PUBLIC;

DO $t$
DECLARE
  U1  constant uuid := '00000000-0000-0000-0000-0000000000a1';  -- contractor C1's user
  UA  constant uuid := '00000000-0000-0000-0000-0000000000ad';  -- template admin's user
  C1  constant uuid := '00000000-0000-0000-0000-0000000000c1';
  C2  constant uuid := '00000000-0000-0000-0000-0000000000c2';
  T   uuid; T2 uuid; Tn uuid; n int; b boolean; st text; s text;
BEGIN

  -- B0 backfill: rows already rejected / admin_validated before the migration were logged
  INSERT INTO _r SELECT 'B0 backfill rows for pre-existing rejected + admin_validated (want 2)', count(*) = 2, count(*)::text FROM public.contractor_template_verdicts;
  INSERT INTO _r SELECT 'B0 pre-existing rejected template blocks auto-validation', public.template_admin_verdict_blocks_auto_validation('00000000-0000-0000-0000-00000000b001'), '';
  INSERT INTO _r SELECT 'B0 pre-existing admin_validated template does not block', NOT public.template_admin_verdict_blocks_auto_validation('00000000-0000-0000-0000-00000000b002'), '';

  -- fixture: C1's roofing/retail template, uploaded by the contractor (insert is forced to pending_validation)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.contractor_templates(contractor_id, trade, funding_type, pdf_storage_path) VALUES (C1,'roofing','retail','c1/v1.pdf') RETURNING id INTO T;
  RESET ROLE;
  -- negative control: never-rejected template does not block
  INSERT INTO _r SELECT 'N1 NEGATIVE CONTROL never-rejected template does not block', NOT public.template_admin_verdict_blocks_auto_validation(T), '';
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T;
  INSERT INTO _r VALUES ('N1 no verdict rows for it', n = 0, n::text);

  -- A1: the template admin rejects it (the admin-template-review.html write)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', UA, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET status='rejected', reviewed_by=UA, reviewed_at=now(), admin_notes='wrong terms' WHERE id = T;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T AND verdict='rejected' AND actor = UA;
  INSERT INTO _r VALUES ('A1 admin reject logged once with actor', n = 1, n::text);
  INSERT INTO _r SELECT 'A1 blocks auto-validation after rejection', public.template_admin_verdict_blocks_auto_validation(T), '';

  -- C1..C5: the contractor cannot touch the log
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN DELETE FROM public.contractor_template_verdicts; INSERT INTO _r VALUES ('C1 contractor DELETE on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C1 contractor DELETE on log refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN UPDATE public.contractor_template_verdicts SET verdict='admin_validated'; INSERT INTO _r VALUES ('C2 contractor UPDATE on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C2 contractor UPDATE on log refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN INSERT INTO public.contractor_template_verdicts(template_id, contractor_id, trade, funding_type, verdict) VALUES (T, C1, 'roofing','retail','admin_validated');
        INSERT INTO _r VALUES ('C3 contractor INSERT on log refused (cannot supersede the rejection)', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C3 contractor INSERT on log refused (cannot supersede the rejection)', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN PERFORM 1 FROM public.contractor_template_verdicts; INSERT INTO _r VALUES ('C4 contractor SELECT on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C4 contractor SELECT on log refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN PERFORM public.template_admin_verdict_blocks_auto_validation(T); INSERT INTO _r VALUES ('C5 contractor EXECUTE on reader refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C5 contractor EXECUTE on reader refused', SQLSTATE = '42501', SQLSTATE); END;
  -- the live freeze_verdict trigger silently reverts a contractor's status write; either that or a 42501 is a pass, a changed status is not
  BEGIN UPDATE public.contractor_templates SET status='admin_validated' WHERE id = T;
        SELECT status INTO st FROM public.contractor_templates WHERE id = T;
        INSERT INTO _r VALUES ('C6 contractor forging status=admin_validated has no effect', st = 'rejected', 'status stays ' || st);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('C6 contractor forging status=admin_validated has no effect', SQLSTATE = '42501', SQLSTATE); END;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T;
  INSERT INTO _r VALUES ('C7 log for the template unchanged after the attacks (still 1 row)', n = 1, n::text);
  INSERT INTO _r SELECT 'C7 still blocks', public.template_admin_verdict_blocks_auto_validation(T), '';

  -- R1: the corrected upload (freeze_verdict reset) does not clear it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET pdf_storage_path='c1/v2-corrected.pdf' WHERE id = T;
  RESET ROLE;
  SELECT status INTO st FROM public.contractor_templates WHERE id = T;
  INSERT INTO _r VALUES ('R1 upload reset ran: status is pending_validation', st = 'pending_validation', st);
  INSERT INTO _r SELECT 'R1 marker SURVIVES the reset (blocks auto-validation)', public.template_admin_verdict_blocks_auto_validation(T), '';
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T;
  INSERT INTO _r VALUES ('R1 reset wrote no log row', n = 1, n::text);

  -- R2: same-PDF re-upload under a new path, and a manual_overrides change, also survive
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET pdf_storage_path='c1/v3-same-pdf-new-path.pdf', manual_overrides='{"a":"b"}' WHERE id = T;
  RESET ROLE;
  INSERT INTO _r SELECT 'R2 survives a second reset with overrides', public.template_admin_verdict_blocks_auto_validation(T), '';

  -- D1: contractor deletes the rejected row and uploads a fresh one in the same slot
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM public.contractor_templates WHERE id = T;
  INSERT INTO public.contractor_templates(contractor_id, trade, funding_type, pdf_storage_path) VALUES (C1,'roofing','retail','c1/fresh.pdf') RETURNING id INTO Tn;
  RESET ROLE;
  INSERT INTO _r VALUES ('D1 delete + re-insert gives a new row id', Tn <> T, '');
  INSERT INTO _r SELECT 'D1 slot-level marker blocks the NEW row', public.template_admin_verdict_blocks_auto_validation(Tn), '';
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T;
  INSERT INTO _r VALUES ('D1 the old row''s log entry outlived its row', n = 1, n::text);

  -- S1: the service role (Edge Function) writing status does not create verdicts, and is not blocked by the log itself
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
  UPDATE public.contractor_templates SET status='submitted_for_admin_review' WHERE id = Tn;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.contractor_template_verdicts;
  INSERT INTO _r VALUES ('S1 EF status write to submitted_for_admin_review logs nothing (log is 3 rows: 2 backfill + 1 reject)', n = 3, n::text);

  -- V1: an admin validating the corrected template supersedes the rejection (last verdict wins), no clearing needed
  PERFORM set_config('request.jwt.claims', json_build_object('sub', UA, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET status='admin_validated', reviewed_by=UA, reviewed_at=now() WHERE id = Tn;
  RESET ROLE;
  INSERT INTO _r SELECT 'V1 after admin_validated the slot no longer blocks', NOT public.template_admin_verdict_blocks_auto_validation(Tn), '';
  -- V2: a later rejection blocks again
  PERFORM set_config('request.jwt.claims', json_build_object('sub', UA, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET status='rejected', reviewed_by=UA, reviewed_at=now() WHERE id = Tn;
  RESET ROLE;
  INSERT INTO _r SELECT 'V2 a later rejection blocks again', public.template_admin_verdict_blocks_auto_validation(Tn), '';

  -- M1: the rejected ROW itself moved to another trade by the contractor stays blocked (row-id match; the new slot has no verdict)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', U1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.contractor_templates SET trade='siding' WHERE id = Tn;
  RESET ROLE;
  SELECT trade INTO st FROM public.contractor_templates WHERE id = Tn;
  INSERT INTO _r VALUES ('M1 rejected row moved to siding', st = 'siding', st);
  INSERT INTO _r SELECT 'M1 still blocked after moving slot (row-id match)', public.template_admin_verdict_blocks_auto_validation(Tn), '';

  -- N2: another contractor's never-rejected template in the same trade is unaffected (isolation + negative control)
  INSERT INTO public.contractor_templates(contractor_id, trade, funding_type, pdf_storage_path) VALUES (C2,'roofing','retail','c2/a.pdf') RETURNING id INTO T2;
  INSERT INTO _r SELECT 'N2 NEGATIVE CONTROL other contractor, same trade/funding, does not block', NOT public.template_admin_verdict_blocks_auto_validation(T2), '';
  INSERT INTO _r SELECT 'N3 unknown template id does not block (and does not error)', NOT public.template_admin_verdict_blocks_auto_validation(gen_random_uuid()), '';

  -- I1 (REVIEW N1b): a row INSERTED directly in a verdict status (service role / admin tooling) is logged too.
  -- service_role has BYPASSRLS (scratch setup mirrors production) and freeze_verdict exempts it.
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
  INSERT INTO public.contractor_templates(contractor_id, trade, funding_type, pdf_storage_path, status) VALUES (C2,'gutters','retail','c2/g.pdf','rejected') RETURNING id INTO T2;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.contractor_template_verdicts WHERE template_id = T2 AND verdict = 'rejected';
  INSERT INTO _r VALUES ('I1 direct INSERT with status=rejected is logged once', n = 1, n::text);
  INSERT INTO _r SELECT 'I1 directly inserted rejected template blocks auto-validation', public.template_admin_verdict_blocks_auto_validation(T2), '';

  -- G1 (REVIEW R1 / N3): the grants the migration leaves, against production-like default ACLs
  INSERT INTO _r SELECT 'G1 service_role holds SELECT on the log', has_table_privilege('service_role', 'public.contractor_template_verdicts', 'SELECT'), '';
  INSERT INTO _r SELECT 'G1 service_role holds no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on the log',
    NOT has_table_privilege('service_role', 'public.contractor_template_verdicts', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
    coalesce((SELECT relacl::text FROM pg_class WHERE oid = 'public.contractor_template_verdicts'::regclass), 'null');
  INSERT INTO _r SELECT 'G1 anon and authenticated hold nothing on the log',
    NOT has_table_privilege('anon', 'public.contractor_template_verdicts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('authenticated', 'public.contractor_template_verdicts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), '';
  INSERT INTO _r SELECT 'G2 append-only trigger function: no EXECUTE for PUBLIC, anon, authenticated',
    NOT has_function_privilege('anon', 'public.contractor_template_verdicts_append_only()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.contractor_template_verdicts_append_only()', 'EXECUTE'),
    coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.contractor_template_verdicts_append_only()'::regprocedure), 'null');

  -- SR1..SR5 (REVIEW R1): the Edge Function's key (service_role, BYPASSRLS) cannot forge, rewrite or wipe the log
  SELECT count(*) INTO n FROM public.contractor_template_verdicts;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN INSERT INTO public.contractor_template_verdicts(template_id, contractor_id, trade, funding_type, verdict) VALUES (Tn, C1, 'siding','retail','admin_validated');
        INSERT INTO _r VALUES ('SR1 service_role INSERT of a forged admin_validated verdict refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('SR1 service_role INSERT of a forged admin_validated verdict refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN UPDATE public.contractor_template_verdicts SET verdict = 'admin_validated'; INSERT INTO _r VALUES ('SR2 service_role UPDATE on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('SR2 service_role UPDATE on log refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN DELETE FROM public.contractor_template_verdicts; INSERT INTO _r VALUES ('SR3 service_role DELETE on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('SR3 service_role DELETE on log refused', SQLSTATE = '42501', SQLSTATE); END;
  BEGIN TRUNCATE public.contractor_template_verdicts; INSERT INTO _r VALUES ('SR4 service_role TRUNCATE on log refused', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('SR4 service_role TRUNCATE on log refused', SQLSTATE = '42501', SQLSTATE); END;
  RESET ROLE;
  INSERT INTO _r SELECT 'SR5 log row count unchanged after the service_role attacks', count(*) = n, count(*)::text || ' of ' || n FROM public.contractor_template_verdicts;
  INSERT INTO _r SELECT 'SR5 the moved rejected row still blocks', public.template_admin_verdict_blocks_auto_validation(Tn), '';

  -- OW1..OW4: the append-only triggers themselves. Run as the table owner (this session: postgres), who holds every
  -- privilege, so only the triggers can refuse; these are what fail if a trigger is dropped or narrowed.
  BEGIN DELETE FROM public.contractor_template_verdicts; INSERT INTO _r VALUES ('OW1 owner DELETE refused by trg_ctv_append_only', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('OW1 owner DELETE refused by trg_ctv_append_only', SQLSTATE = '42501' AND SQLERRM LIKE '%append-only%', SQLSTATE || ' ' || SQLERRM); END;
  BEGIN UPDATE public.contractor_template_verdicts SET verdict = 'admin_validated'; INSERT INTO _r VALUES ('OW2 owner UPDATE refused by trg_ctv_append_only', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('OW2 owner UPDATE refused by trg_ctv_append_only', SQLSTATE = '42501' AND SQLERRM LIKE '%append-only%', SQLSTATE || ' ' || SQLERRM); END;
  BEGIN TRUNCATE public.contractor_template_verdicts; INSERT INTO _r VALUES ('OW3 owner TRUNCATE refused by trg_ctv_no_truncate', false, 'allowed');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('OW3 owner TRUNCATE refused by trg_ctv_no_truncate', SQLSTATE = '42501' AND SQLERRM LIKE '%append-only%', SQLSTATE || ' ' || SQLERRM); END;
  INSERT INTO _r SELECT 'OW4 log row count unchanged after the owner attempts', count(*) = n, count(*)::text || ' of ' || n FROM public.contractor_template_verdicts;
END $t$;

DO $f$
DECLARE s text; nfail int; hdr text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT coalesce(ok,false)) INTO nfail FROM _r;
  hdr := CASE WHEN NOT EXISTS (SELECT 1 FROM _r) THEN 'PROOF-FAIL no checks recorded (the batch above errored)' WHEN nfail = 0 THEN 'PROOF-OK all ' || (SELECT count(*) FROM _r) || ' checks passed' ELSE 'PROOF-FAIL ' || nfail || ' check(s) failed' END;
  SELECT string_agg(CASE WHEN coalesce(ok,false) THEN 'ok   ' ELSE 'FAIL ' END || k || CASE WHEN v <> '' THEN '  [' || v || ']' ELSE '' END, E'\n') INTO s FROM _r;
  RAISE EXCEPTION E'GH3224 PROOF (forced rollback)\n%\n%', hdr, s USING ERRCODE = 'P0U01';
END $f$;
