-- gh-2559 proof (Ben 6029315131 A / B.4): the bid-open guard. A claim can no longer open for bids on an unread estimate, and a summary
-- that repeats the owner's name, street or claim number is refused; the legitimate flow still works.
-- NOT RUN against production when written (read-only access). Run by Marty as a superuser/owner role on yeszghaspzwwstvsrioa.
-- A single DO block whose last action is a deliberate RAISE EXCEPTION, so the forward DDL, the rollback DDL and every fixture write roll
-- back whatever happens; the findings are the exception text. The text between the $fwd$ and $rb$ markers is the body of
-- supabase/migrations_drafts/gh2559_claims_bid_open_guard.sql (without header, gate, COMMENT, BEGIN/COMMIT) and of its rollback
-- (regenerate with tools/gh2559-bid-open-guard-build-proof.py; tests/gh2559-bid-open-guard.mjs checks the embed).
-- Fixture, looked up at run time (nothing hard-coded): one is_test claim whose owner profile is is_test. Each case first resets that claim
-- (as the superuser, triggers bypassed) to the state named in the table, then makes ONE attempt as the named role with the owner's JWT sub.
-- Phases: BEFORE = today's schema (the forbidden cases must print ACCEPTED: the negative control); AFTER = forward applied (they must print
-- REJECTED 23514 [gh2559-bid-open ...]); ROLLBK = rollback applied (back to ACCEPTED). Controls must print ACCEPTED in all three.
-- Production must show, before this proof: SELECT count(*) FROM pg_trigger WHERE tgname='claims_guard_bid_open' = 0 (the proof checks it).

CREATE FUNCTION pg_temp.try_as(p_sub uuid, p_sql text, p_role text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2559-proof@example.invalid')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN CASE WHEN n = 1 THEN 'ACCEPTED' ELSE 'rows=' || n END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || CASE WHEN SQLERRM LIKE '[gh2559-bid-open%' THEN ' [gh2559-bid-open]' ELSE ' ' || left(SQLERRM, 80) END;
  END;
END $f$;

DO $proof$
DECLARE
  v text := '';
  c uuid; owner_id uuid; old_name text;
  fwd text := $fwd$
@@FWD@@$fwd$;
  rb text := $rb$
@@RB@@$rb$;
  good jsonb := '{"sections":[{"name":"Roof","items":[{"desc":"Remove shingles","qty":31.5}]}],"summary":{"rcv":12345.67}}'::jsonb;
  r record;
  ph int; res text[]; k int := 0;
  ADDR constant text := '4417 Quillfeather Ln, Testville, IN 46077';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_bid_open') THEN
    RAISE EXCEPTION 'gh2559 proof: the guard is already applied; run this proof only on the pre-apply schema';
  END IF;
  SELECT cl.id, cl.user_id INTO c, owner_id
    FROM public.claims cl JOIN public.profiles p ON p.id = cl.user_id
   WHERE cl.is_test IS TRUE AND p.is_test IS TRUE
   ORDER BY cl.created_at DESC LIMIT 1;
  IF c IS NULL THEN RAISE EXCEPTION 'gh2559 proof: no is_test claim with an is_test owner; refusing to run on a real row'; END IF;
  PERFORM set_config('session_replication_role', 'replica', true);
  SELECT full_name INTO old_name FROM public.profiles WHERE id = owner_id;
  UPDATE public.profiles SET full_name = 'Zelda Quillfeather' WHERE id = owner_id;
  PERFORM set_config('session_replication_role', 'origin', true);

  CREATE TEMP TABLE cases (id int, label text, est text, parsed jsonb, parsed_at boolean, scope text, claimno text, nm text,
                           preopen boolean, role text, upd text, want_after text, status text, pre_upd text) ON COMMIT DROP;
  INSERT INTO cases VALUES
   (1, 'D1 open on an UNREAD estimate (never parsed)',             'u/est.pdf', NULL,  false, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (2, 'D2 open, parsed_at set but parsed object is {}',           'u/est.pdf', '{}',  true,  NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (3, 'D3 open, parsed object is an error marker',                'u/est.pdf', '{"error":"unreadable"}', true, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (4, 'D4 open, summary repeats the owner name (profile)',        'u/est.pdf', jsonb_set(good, '{sections,0,items}', '[{"desc":"Insured: Zelda Quillfeather","qty":1}]'), true, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (5, 'D5 open, scope summary repeats the street',                'u/est.pdf', good,  true,  'work at 4417 Quillfeather Lane', NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (6, 'D6 open, summary repeats the claim number',                'u/est.pdf', jsonb_set(good, '{summary,ref}', '"CLM-8841-2559"'), true, NULL, 'CLM 8841 2559', NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, NULL),
   (7, 'D7 OPEN claim: parse (service_role) writes a summary with the owner name', 'u/est.pdf', good, true, NULL, NULL, NULL, true, 'service_role',
       $q$parsed_line_items = jsonb_set(parsed_line_items, '{sections,0,items}', '[{"desc":"Zelda Quillfeather","qty":1}]')$q$, 'REJECTED', NULL, NULL),
   (8, 'C1 control: read clean summary opens',                     'u/est.pdf', good,  true,  NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', NULL, NULL),
   (9, 'C2 control: no estimate file opens',                       NULL,        NULL,  false, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', NULL, NULL),
   (10,'C3 control: name Tom Hail vs "hail damage"',               'u/est.pdf', jsonb_set(good, '{sections,0,items}', '[{"desc":"hail damage, parking pad","qty":1}]'), true, NULL, NULL, 'Tom Hail', false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', NULL, NULL),
   (11,'C4 control: claim number 1234 vs RCV 12345.67',            'u/est.pdf', good,  true,  NULL, '1234', NULL, false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', NULL, NULL),
   (12,'C5 control: open claim, unrelated column',                 'u/est.pdf', good,  true,  NULL, NULL, NULL, true, 'authenticated', 'urgency_note_probe = 1', 'ACCEPTED', NULL, NULL),
   (13,'X1 file the parser cannot read (Word/HEIC), platform marked it unsupported: opens', 'u/est.docx', NULL, false, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', 'unsupported', NULL),
   (14,'X1b client writes loss_sheet_parse_status itself (column absent BEFORE: 42703)', 'u/est.docx', NULL, false, NULL, NULL, NULL, false, 'authenticated', $q$loss_sheet_parse_status = 'unsupported'$q$, 'REJECTED', NULL, NULL),
   (15,'X2 parsed PDF, then replaced by an unparsed JPG, then submit (walk-around)', 'u/est.pdf', good, true, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'REJECTED', NULL, $q$estimate_filename = 'u/new.jpg'$q$),
   (16,'F1 client forges a parse (loss_sheet_parsed_at + parsed_line_items) itself', 'u/est.pdf', NULL, false, NULL, NULL, NULL, false, 'authenticated', $q$loss_sheet_parsed_at = now(), parsed_line_items = '{"sections":[{"n":1}]}'::jsonb$q$, 'REJECTED', NULL, NULL),
   (17,'F1b client replaces the file, forges the parse and opens in ONE statement', 'u/est.pdf', good, true, NULL, NULL, NULL, false, 'authenticated', $q$estimate_filename = 'u/new.pdf', loss_sheet_parsed_at = now() + interval '1 minute', parsed_line_items = '{"sections":[{"n":2}]}'::jsonb, ready_for_bids = true$q$, 'REJECTED', NULL, NULL),
   (18,'X1f provider rejected the file (status failed, platform-set): opens', 'u/est.pdf', NULL, false, NULL, NULL, NULL, false, 'authenticated', 'ready_for_bids = true', 'ACCEPTED', 'failed', NULL);
  -- C5 uses a column every claims row has; replace the placeholder with a harmless self-assignment
  UPDATE cases SET upd = 'status = status' WHERE id = 12;

  FOR r IN SELECT * FROM cases ORDER BY id LOOP
    res := ARRAY[]::text[];
    FOR ph IN 1..3 LOOP
      IF ph = 2 THEN EXECUTE fwd; END IF;
      IF ph = 3 THEN EXECUTE rb; END IF;
      PERFORM set_config('session_replication_role', 'replica', true);
      UPDATE public.claims
         SET ready_for_bids = r.preopen, estimate_filename = r.est, has_estimate = (r.est IS NOT NULL),
             parsed_line_items = r.parsed, loss_sheet_parsed_at = CASE WHEN r.parsed_at THEN now() END,
             contractor_scope_summary = r.scope, claim_number = r.claimno, homeowner_name = r.nm, property_address = ADDR
       WHERE id = c;
      IF r.status IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' AND column_name = 'loss_sheet_parse_status') THEN
        EXECUTE format('UPDATE public.claims SET loss_sheet_parse_status = %L WHERE id = %L', r.status, c);
      END IF;
      PERFORM set_config('session_replication_role', 'origin', true);
      IF r.pre_upd IS NOT NULL THEN PERFORM pg_temp.try_as(owner_id, format('UPDATE public.claims SET %s WHERE id = %L', r.pre_upd, c), 'authenticated'); END IF;
      res := res || pg_temp.try_as(owner_id, format('UPDATE public.claims SET %s WHERE id = %L', r.upd, c), r.role);
    END LOOP;
    -- after ROLLBK the guard is gone; re-apply the forward text for the next case's AFTER phase is not needed: each case re-runs ph 2
    v := v || format(E'%s\n    BEFORE %s | AFTER %s | ROLLBK %s | expect AFTER %s%s\n', r.label, res[1], res[2], res[3], r.want_after,
         CASE WHEN left(res[2], 8) = r.want_after OR res[2] = r.want_after THEN '  [as expected]' ELSE '  [UNEXPECTED]' END);
    -- restore the forward-less state: the rollback already ran in ph 3, so the next case starts on the pre-apply schema
  END LOOP;

  v := v || format(E'trigger after final rollback: %s (expect 0)\n', (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_bid_open'));
  UPDATE public.profiles SET full_name = old_name WHERE id = owner_id;
  RAISE EXCEPTION E'GH2559 PROOF (rolled back)\n%', v;
END
$proof$;
