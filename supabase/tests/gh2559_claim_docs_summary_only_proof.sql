-- gh-2559 item 3 proof: D-368 narrowing of the storage policy "Contractors can view biddable claim docs"
-- (supabase/migrations/20261008231142_gh2559_claim_docs_summary_only.sql; NOT APPLIED when this was written, applied 2026-10-08 as ledger version 20261008231142).
-- The bid-open trigger of the previous head was cut (comment 6029315131 item A); its rows G1 to G8 left with it.
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last
-- action is a deliberate RAISE EXCEPTION, so every fixture write (and, in forward-rollback mode, the
-- DDL) rolls back whatever the client does. The findings are the exception text.
--   Run this file alone      : prints the matrix against whatever is live and a VERDICT line
--                              (WIDE before the migration, NARROWED after it).
--   Forward-rollback mode    : replace the two NULLs between the @FWD@ and @RB@ markers with the body of
--                              the migration and of the rollback file, each dollar-quoted (use the tags
--                              $fwd$ and $rb$) and with its BEGIN; and COMMIT; lines removed. The block
--                              then prints the matrix three times: live, after forward, after rollback.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read.
-- "obj" lines count the rows of storage.objects the caller can SELECT for ONE named object (or the whole
-- claim-documents bucket). "sum" lines count the claim row WITH its parsed summary present. "cols" lines
-- count the claim row selected with homeowner_name, claim_number and estimate_filename (the claims row is
-- PR #2578, so those stay readable here and are reported as such). File contents
-- and summary contents are never read.
--
-- NO IDENTIFIER IS HARD-CODED. Every fixture is looked up at run time by what it is:
--   kT   active is_test contractor that owns no claim and is selected nowhere (test-world BIDDER)
--   kR   another such contractor; the block sets is_test = false on it (rolled back): the real BIDDER.
--        Production has no active real contractor to use instead.
--   kS   active is_test contractor with a bid on claim cC (below), owning no claim and selected nowhere;
--        the block selects it on cC (closed for bids) and on cE (left open): the SELECTED contractor.
--   kT, kR  chosen after kS, so all three differ
--   cE   test claim open for bids with an estimate object and a parsed summary
--   cM   test claim open for bids with a measurements object, other than cE
--   cC   test claim open for bids that kS has a bid on, with a measurements object in its own folder
--        (the block closes it for bids and selects kS on it)
--   cR   real claim open for bids with BOTH an estimate object and a measurements object (the mislabelled
--        copy case: on 2026-10-06 the two objects have the same size and eTag)
--   cR2  another real claim open for bids with a measurements object
--   ownE, ownR  the claim owners of cE and cR; kP  a contractor that is pending_approval
--   admin email  read out of the live text of public.is_admin_email()
-- The FIXTURES lines print roles and flags, never ids.
--
-- Expected, WIDE -> NARROWED (everything else must be identical):
--   B1  test bidder, test open claim ESTIMATE object              1 -> 0   (D-368)
--   B2  test bidder, test open claim MEASUREMENTS object          1 -> 0   (raw upload, withheld)
--   B3  test bidder, the claim row with its parsed summary        1 -> 1   (keeps the summary)
--   B4  test bidder, the claim row's three personal columns       1 -> 1   (STILL READABLE: split to its own PR)
--   R1  real bidder, real open claim ESTIMATE object              1 -> 0
--   R2  real bidder, real open claim MEASUREMENTS object (the
--       byte-identical copy of the estimate)                      1 -> 0   (REVIEW FAIL item 1)
--   R3  real bidder, another real claim's MEASUREMENTS object     1 -> 0
--   R4  real bidder, the real claim row with its parsed summary   1 -> 1
--   R5  real bidder, the real claim row's three personal columns  1 -> 1   (STILL READABLE: split)
--   X1  test bidder, an estimate object the row no longer names   1 -> 0
--   E1  test bidder, one object named in BOTH slots               1 -> 0
--   S1  selected contractor, claim closed for bids, measurements  1 -> 1   (selected branch unchanged)
--   S2  selected contractor, the claim's ESTIMATE object          1 -> 1   (selected branch unchanged)
--   S3  selected contractor, that claim's row with its summary    1 -> 1
--   F1  test bidder, real claim ESTIMATE object                   0 -> 0   (world fence, live today)
--   F2  test bidder, real claim MEASUREMENTS object               0 -> 0
--   F3  real bidder, test claim ESTIMATE object                   0 -> 0
--   O1, O2  the claim owner, own estimate object                  1 -> 1
--   O3  a homeowner, another homeowner's estimate object          0 -> 0
--   P1  pending_approval contractor, whole bucket                 0 -> 0
--   AD  a session carrying an admin email, whole bucket           0 -> 0
--   V1  service_role, whole bucket                                unchanged
--   A1  anon, whole bucket                                        0 -> 0
--   T-all, R-all, S-all  whole bucket for each contractor: the expected counts are computed by an
--       independent query over claims and objects (WIDE = open biddable claims in the contractor's own
--       world plus claims selected to it; NARROWED = claims selected to it only)
--   W1  homeowner session writes an object at {claim id}/... (the proposed server-only prefix)  refused both
--   W2  the same session writes an object under its own user id                                  allowed both
--   OTHER  md5 over every other policy on storage.objects and over the public.claims policies, and the
--          count and md5 of the triggers on public.claims: identical in every phase (this change adds none).
DO $proof$
DECLARE
  v_fwd text := /*@FWD@*/ NULL /*@FWD@*/;
  v_rb  text := /*@RB@*/ NULL /*@RB@*/;
  c_pol constant text := 'Contractors can view biddable claim docs';
  kT uuid; kTu uuid; kR uuid; kRu uuid; kS uuid; kSu uuid; kP uuid; kPu uuid;
  cE uuid; cM uuid; cC uuid; cR uuid; cR2 uuid;
  ownE uuid; ownR uuid;
  oidE uuid; oidM uuid; oidR_est uuid; oidR_meas uuid; oidR2 uuid; oidC uuid;
  v_admin text;
  out text := '';
  phase text;
  phases text[];
  r record;
  n bigint;
  v_wide boolean;
  v_narrow boolean;
  t text;
  sv_est text; sv_meas text;
  exp_wide bigint; exp_narrow bigint;
BEGIN
  -- ---------------------------------------------------------------- fixture lookup (superuser)
  -- kS and cC together: a contractor with a bid on a test claim that has a measurements object in the
  -- claim's own folder. The bid matters: a contractor reads a claim row (and so, through the storage
  -- policy, its files) after the claim closes only through "Contractors can view claims for their quotes".
  SELECT ct.id, ct.user_id, c.id INTO kS, kSu, cC
    FROM public.quotes q
    JOIN public.contractors ct ON ct.id = q.contractor_id AND ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
    JOIN public.claims c ON c.id = q.claim_id AND c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending')
   WHERE NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.selected_contractor_id = ct.id)
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.measurements_filename
                    AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY ct.id, c.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kT, kTu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL AND ct.id <> kS
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kR, kRu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL AND ct.id NOT IN (kS, kT)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kP, kPu FROM public.contractors ct
   WHERE ct.status = 'pending_approval' AND ct.user_id IS NOT NULL ORDER BY ct.id LIMIT 1;

  -- claims that have the objects we need (object names are the claim row's own file names)
  SELECT c.id, c.user_id INTO cE, ownE FROM public.claims c
   WHERE c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.id <> cC
     AND c.estimate_filename IS NOT NULL AND c.parsed_line_items IS NOT NULL AND c.contractor_scope_summary IS NOT NULL
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.estimate_filename AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY c.id LIMIT 1;
  SELECT c.id INTO cM FROM public.claims c
   WHERE c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.id NOT IN (cE, cC)
     AND c.measurements_filename IS NOT NULL AND c.measurements_filename IS DISTINCT FROM c.estimate_filename
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.measurements_filename AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY c.id LIMIT 1;
  SELECT c.id, c.user_id INTO cR, ownR FROM public.claims c
   WHERE NOT c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending')
     AND c.estimate_filename IS NOT NULL AND c.measurements_filename IS NOT NULL
     AND c.estimate_filename <> c.measurements_filename
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.estimate_filename AND (storage.foldername(o.name))[2] = c.id::text)
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.measurements_filename AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY c.id LIMIT 1;
  SELECT c.id INTO cR2 FROM public.claims c
   WHERE NOT c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.id <> cR
     AND c.measurements_filename IS NOT NULL
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.measurements_filename AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY c.id LIMIT 1;

  SELECT o.id INTO oidE FROM storage.objects o JOIN public.claims c ON c.id = cE AND o.name = c.estimate_filename AND o.bucket_id = 'claim-documents';
  SELECT o.id INTO oidM FROM storage.objects o JOIN public.claims c ON c.id = cM AND o.name = c.measurements_filename AND o.bucket_id = 'claim-documents';
  SELECT o.id INTO oidR_est FROM storage.objects o JOIN public.claims c ON c.id = cR AND o.name = c.estimate_filename AND o.bucket_id = 'claim-documents';
  SELECT o.id INTO oidR_meas FROM storage.objects o JOIN public.claims c ON c.id = cR AND o.name = c.measurements_filename AND o.bucket_id = 'claim-documents';
  SELECT o.id INTO oidR2 FROM storage.objects o JOIN public.claims c ON c.id = cR2 AND o.name = c.measurements_filename AND o.bucket_id = 'claim-documents';
  SELECT o.id INTO oidC FROM storage.objects o JOIN public.claims c ON c.id = cC AND o.name = c.measurements_filename AND o.bucket_id = 'claim-documents';

  v_admin := substring(pg_get_functiondef('public.is_admin_email()'::regprocedure) FROM '''([^'']+@[^'']+)''');

  IF kT IS NULL OR kR IS NULL OR kS IS NULL OR kP IS NULL OR cE IS NULL OR cM IS NULL OR cC IS NULL
     OR cR IS NULL OR cR2 IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'gh2559 proof: FIXTURE MISSING kT=% kR=% kS=% kP=% cE=% cM=% cC=% cR=% cR2=% admin=%',
      kT IS NOT NULL, kR IS NOT NULL, kS IS NOT NULL, kP IS NOT NULL, cE IS NOT NULL, cM IS NOT NULL, cC IS NOT NULL,
      cR IS NOT NULL, cR2 IS NOT NULL, v_admin IS NOT NULL USING ERRCODE = 'P0U02';
  END IF;

  -- ---------------------------------------------------------------- fixture changes (rolled back)
  UPDATE public.contractors SET is_test = false WHERE id = kR;
  UPDATE public.claims SET ready_for_bids = false, selected_contractor_id = kS WHERE id = cC;
  UPDATE public.claims SET selected_contractor_id = kS WHERE id = cE;
  SELECT estimate_filename, measurements_filename INTO sv_est, sv_meas FROM public.claims WHERE id = cE;

  out := out || 'FIXTURES contractors (role flags only): '
    || 'kT test-bidder is_test=' || (SELECT is_test FROM public.contractors WHERE id = kT)
    || ' ; kR real-bidder is_test=' || (SELECT is_test FROM public.contractors WHERE id = kR) || ' (flipped in the block)'
    || ' ; kS selected is_test=' || (SELECT is_test FROM public.contractors WHERE id = kS)
    || ' ; kP pending status=' || (SELECT status FROM public.contractors WHERE id = kP) || E'\n';
  out := out || 'FIXTURES claims: ' || (
    SELECT string_agg(lbl || ' is_test=' || c.is_test || ' ' || c.status || ' rfb=' || c.ready_for_bids
           || ' selected=' || (c.selected_contractor_id IS NOT NULL)
           || ' est=' || (c.estimate_filename IS NOT NULL) || ' meas=' || (c.measurements_filename IS NOT NULL)
           || ' summary=' || (c.parsed_line_items IS NOT NULL AND c.contractor_scope_summary IS NOT NULL), ' ; ' ORDER BY lbl)
    FROM (VALUES ('cE', cE), ('cM', cM), ('cC', cC), ('cR', cR), ('cR2', cR2)) v(lbl, cid)
    JOIN public.claims c ON c.id = v.cid) || E'\n';
  out := out || 'FIXTURES cR objects: estimate and measurements are two objects=' || (oidR_est <> oidR_meas)
    || ' same size=' || ((SELECT metadata->>'size' FROM storage.objects WHERE id = oidR_est) = (SELECT metadata->>'size' FROM storage.objects WHERE id = oidR_meas))
    || ' same eTag=' || ((SELECT metadata->>'eTag' FROM storage.objects WHERE id = oidR_est) = (SELECT metadata->>'eTag' FROM storage.objects WHERE id = oidR_meas)) || E'\n';

  phases := CASE WHEN v_fwd IS NULL THEN ARRAY['live'] ELSE ARRAY['live', 'after forward', 'after rollback'] END;

  FOREACH phase IN ARRAY phases LOOP
    IF phase = 'after forward' THEN EXECUTE v_fwd; END IF;
    IF phase = 'after rollback' THEN EXECUTE v_rb; END IF;

    out := out || E'\n== ' || phase || E' ==\n';
    SELECT 'POLICY roles=' || roles::text || ' cmd=' || cmd || ' qual_md5=' || left(md5(qual), 8) || '...  selected_leg=' || (qual LIKE '%selected_contractor_id%')
           || ' bidding_leg=' || (qual LIKE '%ready_for_bids%') || ' world_fence=' || (qual LIKE '%is_test = ct.is_test%')
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = c_pol;
    out := out || coalesce(t, 'POLICY MISSING') || E'\n';
    SELECT 'OTHER policies on storage.objects: n=' || count(*) || ' md5=' || left(md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)), 8) || '...'
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname <> c_pol;
    out := out || t || E'\n';
    SELECT 'CLAIMS policies on public.claims: n=' || count(*) || ' md5=' || left(md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)), 8) || '...'
      INTO t FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims';
    out := out || t || E'\n';
    SELECT 'TRIGGERS on public.claims: n=' || count(*) || ' bid_open_trigger_present=' || coalesce(bool_or(tgname = 'claims_guard_bid_release'), false)
           || ' md5_of_all_trigger_defs=' || left(md5(string_agg(pg_get_triggerdef(oid), E'\n' ORDER BY tgname)), 8) || '...'
      INTO t FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND NOT tgisinternal;
    out := out || t || E'\n';

    v_wide := true; v_narrow := true;
    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'B1 test bidder -> test open claim cE ESTIMATE object',                  'authenticated', kTu, NULL::text, 'obj', oidE, NULL::text, 1, 0),
        ( 2, 'B2 test bidder -> test open claim cM MEASUREMENTS object',              'authenticated', kTu, NULL, 'obj', oidM, NULL, 1, 0),
        ( 3, 'B3 test bidder -> claim row cE with its parsed summary',                'authenticated', kTu, NULL, 'sum', cE, NULL, 1, 1),
        ( 4, 'B4 test bidder -> claim row cE, columns homeowner_name/claim_number/estimate_filename (STILL READABLE)', 'authenticated', kTu, NULL, 'cols', cE, NULL, 1, 1),
        ( 5, 'R1 real bidder -> real open claim cR ESTIMATE object',                  'authenticated', kRu, NULL, 'obj', oidR_est, NULL, 1, 0),
        ( 6, 'R2 real bidder -> real open claim cR MEASUREMENTS object (copy of the estimate)', 'authenticated', kRu, NULL, 'obj', oidR_meas, NULL, 1, 0),
        ( 7, 'R3 real bidder -> real open claim cR2 MEASUREMENTS object',             'authenticated', kRu, NULL, 'obj', oidR2, NULL, 1, 0),
        ( 8, 'R4 real bidder -> claim row cR with its parsed summary',                'authenticated', kRu, NULL, 'sum', cR, NULL, 1, 1),
        ( 9, 'R5 real bidder -> claim row cR, columns homeowner_name/claim_number/estimate_filename (STILL READABLE)', 'authenticated', kRu, NULL, 'cols', cR, NULL, 1, 1),
        (10, 'X1 test bidder -> cE estimate object the row no longer names',          'authenticated', kTu, NULL, 'obj', oidE, 'supersede', 1, 0),
        (11, 'E1 test bidder -> cE object named in BOTH slots',                       'authenticated', kTu, NULL, 'obj', oidE, 'sameslot', 1, 0),
        (12, 'S1 selected contractor -> cC measurements object, claim closed for bids', 'authenticated', kSu, NULL, 'obj', oidC, NULL, 1, 1),
        (13, 'S2 selected contractor -> cE ESTIMATE object',                          'authenticated', kSu, NULL, 'obj', oidE, NULL, 1, 1),
        (14, 'S3 selected contractor -> claim row cE with its parsed summary',        'authenticated', kSu, NULL, 'sum', cE, NULL, 1, 1),
        (15, 'F1 test bidder -> real claim cR ESTIMATE object (world fence)',         'authenticated', kTu, NULL, 'obj', oidR_est, NULL, 0, 0),
        (16, 'F2 test bidder -> real claim cR MEASUREMENTS object (world fence)',     'authenticated', kTu, NULL, 'obj', oidR_meas, NULL, 0, 0),
        (17, 'F3 real bidder -> test claim cE ESTIMATE object (world fence)',         'authenticated', kRu, NULL, 'obj', oidE, NULL, 0, 0),
        (18, 'O1 owner of cE -> own estimate object',                                 'authenticated', ownE, NULL, 'obj', oidE, NULL, 1, 1),
        (19, 'O2 owner of cR -> own estimate object',                                 'authenticated', ownR, NULL, 'obj', oidR_est, NULL, 1, 1),
        (20, 'O3 owner of cR -> another homeowner''s estimate object',                'authenticated', ownR, NULL, 'obj', oidE, NULL, 0, 0),
        (21, 'P1 pending_approval contractor -> whole claim-documents bucket',        'authenticated', kPu, NULL, 'obj', NULL::uuid, NULL, 0, 0),
        (22, 'AD admin-email session -> whole claim-documents bucket',                'authenticated', '00000000-0000-4000-8000-000000002559'::uuid, v_admin, 'obj', NULL, NULL, 0, 0),
        (23, 'V1 service_role -> whole claim-documents bucket',                       'service_role',  NULL::uuid, NULL, 'objall', NULL, NULL, -1, -1),
        (24, 'A1 anon -> whole claim-documents bucket',                               'anon',          NULL::uuid, NULL, 'obj', NULL, NULL, 0, 0),
        (25, 'T-all test bidder -> whole bucket (oracle count)',                      'authenticated', kTu, NULL, 'ball', kT, NULL, -1, -1),
        (26, 'R-all real bidder -> whole bucket (oracle count)',                      'authenticated', kRu, NULL, 'ball', kR, NULL, -1, -1),
        (27, 'S-all selected contractor -> whole bucket (oracle count)',              'authenticated', kSu, NULL, 'ball', kS, NULL, -1, -1),
        (28, 'W1 homeowner session writes an object at {claim id}/... (proposed server-only prefix)', 'authenticated', ownE, NULL, 'write_claimprefix', cE, NULL, 0, 0),
        (29, 'W2 same session writes under its own user id (control for W1)',                          'authenticated', ownE, NULL, 'write_ownprefix', cE, NULL, 1, 1)
      ) AS s(ord, label, role, sub, email, kind, target, mut, wide, narrowed) ORDER BY ord
    LOOP
      exp_wide := r.wide; exp_narrow := r.narrowed;

      -- oracle counts for the whole-bucket rows, computed as superuser before any role switch
      IF r.kind = 'objall' THEN
        SELECT count(*) INTO exp_wide FROM storage.objects WHERE bucket_id = 'claim-documents'; exp_narrow := exp_wide;
      ELSIF r.kind = 'ball' THEN
        SELECT count(*) INTO exp_wide FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
          JOIN public.contractors ct ON ct.id = r.target::uuid AND ct.status = 'active'
         WHERE o.bucket_id = 'claim-documents'
           AND ((c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.is_test = ct.is_test) OR c.selected_contractor_id = ct.id);
        SELECT count(*) INTO exp_narrow FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
          JOIN public.contractors ct ON ct.id = r.target::uuid AND ct.status = 'active'
         WHERE o.bucket_id = 'claim-documents' AND c.selected_contractor_id = ct.id;
      END IF;

      -- one-read fixture changes, as superuser, put back straight after the read
      IF r.mut = 'supersede' THEN
        UPDATE public.claims SET estimate_filename = sv_est || '.superseded' WHERE id = cE;
      ELSIF r.mut = 'sameslot' THEN
        UPDATE public.claims SET measurements_filename = sv_est WHERE id = cE;
      END IF;


      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', coalesce(r.email, 'gh2559-proof@example.invalid'))::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        IF r.kind = 'sum' THEN
          EXECUTE 'SELECT count(*) FROM public.claims WHERE id = $1 AND parsed_line_items IS NOT NULL AND contractor_scope_summary IS NOT NULL'
            INTO n USING r.target;
        ELSIF r.kind = 'cols' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT homeowner_name, claim_number, estimate_filename FROM public.claims WHERE id = $1) q'
            INTO n USING r.target;
        ELSIF r.kind = 'write_claimprefix' THEN
          BEGIN
            EXECUTE 'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (''claim-documents'', $1 || ''/hover_measurements_proof-'' || $3 || ''.pdf'', $2)'
              USING r.target::text, r.sub::text, replace(phase, ' ', '_');
            n := 1;
          EXCEPTION WHEN insufficient_privilege THEN n := 0;
          END;
        ELSIF r.kind = 'write_ownprefix' THEN
          BEGIN
            EXECUTE 'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (''claim-documents'', $1 || ''/proof-'' || $2 || ''.pdf'', $1)'
              USING r.sub::text, replace(phase, ' ', '_');
            n := 1;
          EXCEPTION WHEN insufficient_privilege THEN n := 0;
          END;
        ELSIF r.kind IN ('objall', 'ball') THEN
          EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents''' INTO n;
        ELSE
          EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents'' AND ($1 IS NULL OR id = $1)'
            INTO n USING r.target;
        END IF;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : rows=' || n || '  (wide ' || exp_wide || ', narrowed ' || exp_narrow || ')' || E'\n';
        v_wide := v_wide AND n = exp_wide;
        v_narrow := v_narrow AND n = exp_narrow;
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
        v_wide := false; v_narrow := false;
      END;

      IF r.mut IN ('supersede', 'sameslot') THEN
        UPDATE public.claims SET estimate_filename = sv_est, measurements_filename = sv_meas WHERE id = cE;
      END IF;
    END LOOP;
    out := out || 'VERDICT ' || phase || ': ' ||
           CASE WHEN v_narrow THEN 'NARROWED' WHEN v_wide THEN 'WIDE' ELSE 'UNEXPECTED' END || E'\n';
  END LOOP;

  RAISE EXCEPTION E'gh2559 summary-only proof (rolled back) db_now=%\n%', now(), out USING ERRCODE = 'P0U01';
END
$proof$;
