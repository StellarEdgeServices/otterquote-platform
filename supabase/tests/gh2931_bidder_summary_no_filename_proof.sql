-- gh-2931 proof: public.bidder_claim_summary returns estimate_filename to the selected contractor only after claims.platform_fee_charged IS TRUE.
-- Forward file : supabase/migrations_drafts/gh2931_bidder_summary_no_filename.sql
-- Rollback file: supabase/migrations_drafts/gh2931_bidder_summary_no_filename_rollback.sql
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. BEGIN; DO ...; ROLLBACK; -- the DO block's last action is a deliberate
-- RAISE EXCEPTION, so every fixture write and every DDL statement rolls back whatever the client does. The findings are the exception text.
--   As committed (the two markers hold NULL): prints the LIVE matrix = the NEGATIVE CONTROL (the filename is readable by the selected
--     contractor today, NULL for a bidder, and the column exists).
--   Built (python3 supabase/tests/gh2931_bidder_summary_no_filename_proof_run.py --emit <file>): the markers hold the forward and rollback
--     migration bodies (BEGIN;/COMMIT; removed, each dollar-quoted) and the block prints the matrix three times: live, after forward, after rollback.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read. NO IDENTIFIER IS HARD-CODED:
--   kS, cS  active is_test contractor owning no claim, selected on cS with a 'selected' quote (the contractor the homeowner chose)
--   kQ, cQ  another active is_test contractor, owning no claim, selected nowhere, with a 'submitted' quote on the open test claim cQ (a BIDDER)
-- Fixture write (rolled back): both claims get estimate_filename = '<uuid>/<uuid>/1785930673843-Jane Q Doe - Acme Mutual - 0712345678.pdf',
-- the shape of a real stored path (homeowner name - insurer - claim number). File contents are never read: reads are counts and null-tests.
-- Fixture write (rolled back): both claims get estimate_filename = '<uuid>/<uuid>/1785930673843-Jane Q Doe - Acme Mutual - 0712345678.pdf' and the
-- block sets claims.platform_fee_charged to false or true per row.
-- Expected (live / after forward / after rollback):
--   S1  selected contractor, fee NOT charged, reads estimate_filename IS NOT NULL   1 / 0 / 1   (today the path is handed out at selection)
--   S1f selected contractor, fee charged                                            1 / 1 / 1   (after the fee nothing changes)
--   Q1, Q1f bidder (not selected), fee not charged / charged                        0 / 0 / 0   (a bidder already reads NULL)
--   S2, Q2 has_estimate (fee not charged)                                           1 / 1 / 1
--   S3  selected, fee not charged: any column holds the original upload name        1 / 0 / 1
--   S3f selected, fee charged                                                       1 / 1 / 1
--   Q3  bidder: any column holds the original upload name                           0 / 0 / 0
-- Structure per phase: 40 columns, same names/types/order, owner, reloptions, relacl and comment identical to live; pg_get_viewdef md5 c8ad94c4 / d57105ca / c8ad94c4.
BEGIN;
DO $proof$
DECLARE
  v_fwd text := /*@F@*/ NULL /*@F@*/;
  v_rb  text := /*@R@*/ NULL /*@R@*/;
  c_name constant text := 'Jane Q Doe';
  kS uuid; kSu uuid; cS uuid; kQ uuid; kQu uuid; cQ uuid;
  phases text[]; phase text; pidx int;
  out text := ''; r record; n bigint; t text; exp_n bigint;
  ok_all boolean := true; ok_struct boolean := true;
  b_names text; b_owner text; b_opts text; b_acl text; b_cmt text; b_md5 text; b_ncols int;
  s_names text; s_owner text; s_opts text; s_acl text; s_cmt text; s_md5 text; s_ncols int;
BEGIN
  SELECT ct.id, ct.user_id, c.id INTO kS, kSu, cS
    FROM public.contractors ct
    JOIN public.claims c ON c.selected_contractor_id = ct.id
    JOIN public.quotes q ON q.claim_id = c.id AND q.contractor_id = ct.id AND q.status = 'selected'
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.user_id = ct.user_id)
   ORDER BY ct.id, c.id LIMIT 1;
  SELECT ct.id, ct.user_id, c.id INTO kQ, kQu, cQ
    FROM public.quotes q
    JOIN public.contractors ct ON ct.id = q.contractor_id AND ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
    JOIN public.claims c ON c.id = q.claim_id AND c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending')
                        AND c.selected_contractor_id IS NULL
   WHERE q.status = 'submitted' AND ct.id <> kS
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.selected_contractor_id = ct.id)
   ORDER BY ct.id, c.id LIMIT 1;
  IF kS IS NULL OR kQ IS NULL THEN
    RAISE EXCEPTION 'gh2931 proof: FIXTURE MISSING selected=% bidder=%', kS IS NOT NULL, kQ IS NOT NULL USING ERRCODE = 'P0U02';
  END IF;

  -- fixture write (rolled back): a stored path of the real shape, original name included
  UPDATE public.claims SET estimate_filename = gen_random_uuid()::text || '/' || id::text || '/1785930673843-' || c_name || ' - Acme Mutual - 0712345678.pdf' WHERE id IN (cS, cQ);

  phases := CASE WHEN v_fwd IS NULL THEN ARRAY['live'] ELSE ARRAY['live', 'after forward', 'after rollback'] END;
  FOR pidx IN 1 .. array_length(phases, 1) LOOP
    phase := phases[pidx];
    IF phase = 'after forward' THEN EXECUTE v_fwd; END IF;
    IF phase = 'after rollback' THEN EXECUTE v_rb; END IF;
    out := out || E'\n== ' || phase || E' ==\n';

    -- structure
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FILTER (WHERE attname <> 'estimate_filename'), count(*)
      INTO s_names, s_ncols FROM pg_attribute WHERE attrelid = 'public.bidder_claim_summary'::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT relowner::regrole::text, reloptions::text, relacl::text, obj_description(oid, 'pg_class')
      INTO s_owner, s_opts, s_acl, s_cmt FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass;
    s_md5 := md5(pg_get_viewdef('public.bidder_claim_summary'::regclass, true));
    IF pidx = 1 THEN b_names := s_names; b_owner := s_owner; b_opts := s_opts; b_acl := s_acl; b_cmt := s_cmt; b_md5 := s_md5; b_ncols := s_ncols; END IF;
    out := out || 'STRUCT columns=' || s_ncols || ' estimate_filename_present=' ||
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.bidder_claim_summary'::regclass AND attnum > 0 AND NOT attisdropped AND attname = 'estimate_filename')
      || ' owner=' || s_owner || ' options=' || s_opts || ' acl=' || s_acl || ' viewdef_md5=' || left(s_md5, 8) || E'\n';
    IF s_names IS DISTINCT FROM b_names OR s_owner IS DISTINCT FROM b_owner OR s_opts IS DISTINCT FROM b_opts OR s_acl IS DISTINCT FROM b_acl
       OR s_cmt IS DISTINCT FROM b_cmt
       OR s_ncols IS DISTINCT FROM b_ncols
       OR (phase = 'after rollback' AND s_md5 IS DISTINCT FROM b_md5) THEN
      ok_struct := false; out := out || E'STRUCT MISMATCH   <-- the other columns, owner, options, grants or comment differ from live\n';
    END IF;

    FOR r IN
      SELECT * FROM (VALUES
        ('S1  selected contractor, fee not charged: estimate_filename IS NOT NULL', kSu, cS, 'fn',  false, ARRAY[1, 0, 1]::bigint[]),
        ('S1f selected contractor, fee charged: estimate_filename IS NOT NULL',     kSu, cS, 'fn',  true,  ARRAY[1, 1, 1]::bigint[]),
        ('Q1  bidder, fee not charged: estimate_filename IS NOT NULL',              kQu, cQ, 'fn',  false, ARRAY[0, 0, 0]::bigint[]),
        ('Q1f bidder, fee charged: estimate_filename IS NOT NULL',                  kQu, cQ, 'fn',  true,  ARRAY[0, 0, 0]::bigint[]),
        ('S2  selected contractor: has_estimate',                                   kSu, cS, 'has', false, ARRAY[1, 1, 1]::bigint[]),
        ('Q2  bidder: has_estimate',                                                kQu, cQ, 'has', false, ARRAY[1, 1, 1]::bigint[]),
        ('S3  selected, fee not charged: any column holds the upload name',         kSu, cS, 'any', false, ARRAY[1, 0, 1]::bigint[]),
        ('S3f selected, fee charged: any column holds the upload name',             kSu, cS, 'any', true,  ARRAY[1, 1, 1]::bigint[]),
        ('Q3  bidder: any column holds the upload name',                            kQu, cQ, 'any', false, ARRAY[0, 0, 0]::bigint[])
      ) v(label, sub, target, kind, fee, expd)
    LOOP
      exp_n := r.expd[CASE WHEN phase = 'live' THEN 1 WHEN phase = 'after forward' THEN 2 ELSE 3 END];
      UPDATE public.claims SET platform_fee_charged = r.fee WHERE id IN (cS, cQ);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', r.sub, 'role', 'authenticated', 'email', 'gh2931-proof@example.invalid')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        IF r.kind = 'fn' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND estimate_filename IS NOT NULL' INTO n USING r.target;
        ELSIF r.kind = 'has' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND has_estimate' INTO n USING r.target;
        ELSIF r.kind = 'any' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary v WHERE v.id = $1 AND to_jsonb(v)::text LIKE ''%'' || $2 || ''%''' INTO n USING r.target, c_name;
        END IF;
      EXCEPTION
                WHEN OTHERS THEN
          EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
          out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n'; n := -9;
      END;
      EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
      out := out || r.label || ' : ' || n || '  (expected ' || exp_n || ')' || CASE WHEN n = exp_n THEN '' ELSE '   <-- MISMATCH' END || E'\n';
      IF n <> exp_n THEN ok_all := false; END IF;
    END LOOP;
  END LOOP;

  out := out || E'\nVERDICT reads=' || CASE WHEN ok_all THEN 'AS EXPECTED' ELSE 'UNEXPECTED' END
    || ' ; structure=' || CASE WHEN ok_struct THEN 'AS EXPECTED' ELSE 'UNEXPECTED' END
    || CASE WHEN v_fwd IS NULL THEN ' (live only: the negative control; the forward/rollback phases need the built file)' ELSE '' END || E'\n';
  RAISE EXCEPTION E'gh2931 bidder summary proof (rolled back) db_now=%\n%', now(), out USING ERRCODE = 'P0U01';
END
$proof$;
ROLLBACK;
