-- gh-2559 item 3 proof: D-368 narrowing of the storage policy "Contractors can view biddable claim docs"
-- (supabase/migrations_drafts/gh2559_claim_docs_summary_only.sql; NOT APPLIED when this was written).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last
-- action is a deliberate RAISE EXCEPTION, so every fixture write (and, in forward-rollback mode, the
-- policy DDL) rolls back whatever the client does. The findings are the exception text.
--   Run this file alone      : prints the matrix against whatever policy is live and a VERDICT line
--                              (WIDE before the migration, NARROWED after it).
--   Forward-rollback mode    : replace the two NULLs between the @FWD@ and @RB@ markers with the body of
--                              the migration and of the rollback file, each dollar-quoted and with its
--                              BEGIN; and COMMIT; lines removed. The block then prints the matrix three
--                              times: live, after the forward DDL, after the rollback DDL.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read.
-- "obj" lines count the rows of storage.objects the caller can SELECT for ONE named object id (or the
-- whole claim-documents bucket). "sum" lines count the rows of public.claims the caller can SELECT for
-- one claim id WITH its parsed summary present (parsed_line_items and contractor_scope_summary both
-- non-null): that is the summary a bidder keeps. File contents and summary contents are never read.
--
-- Fixtures (production ids, read 2026-10-06; the FIXTURES lines print their live flags):
--   k1  contractor 986ce2b6, login d4def812: is_test, active, no selection anywhere. The test-world BIDDER.
--   k2  contractor bb07fc40, login 189b85ad: is_test, active. The block sets is_test = false on it as
--       superuser (rolled back), which makes it the real-world BIDDER. Production has no active
--       is_test = false contractor to use instead.
--   k4  contractor 5e76adc9, login 901008b8: is_test, active, with a bid on test claim ba90c501. The
--       block (a) closes ba90c501 for bids and selects k4 on it, and (b) selects k4 on test claim
--       f3bfb1f9 while it stays open, so k4 is the SELECTED contractor on both (all rolled back).
--   test claim f3bfb1f9, open for bids, estimate uploaded and parsed: estimate object 6f4cc57f,
--       owner login e6588b43.
--   test claim 38ffb84a, open for bids: measurements object 58f2e18d.
--   test claim ba90c501: measurements object d34fdd63.
--   real claim c5ebaa5d, open for bids, estimate uploaded and parsed: estimate object f3fe8908,
--       measurements object 4ce02f4b, owner login 10bc0bd2.
--   real claim 5c16cc1e, open for bids: measurements object 7be4f256.
--   X1 and E1 change claims.estimate_filename / measurements_filename of f3bfb1f9 for one read each and
--       put the value back (and the whole block rolls back anyway).
--
-- Expected, WIDE -> NARROWED (everything else must be identical):
--   B1  test bidder, test open claim's ESTIMATE object            1 -> 0   (D-368)
--   B2  test bidder, test open claim's MEASUREMENTS object        1 -> 1
--   B3  test bidder, the claim row with its parsed summary        1 -> 1   (keeps the summary)
--   R1  real bidder, real open claim's ESTIMATE object            1 -> 0   (D-368)
--   R2  real bidder, real open claim's MEASUREMENTS object        1 -> 1
--   R3  real bidder, another real open claim's MEASUREMENTS       1 -> 1
--   R4  real bidder, the real claim row with its parsed summary   1 -> 1   (keeps the summary)
--   X1  test bidder, an estimate object the claim row no longer
--       names (a superseded upload)                               1 -> 0
--   E1  test bidder, one object named in BOTH slots               1 -> 0
--   S1  selected contractor, claim closed for bids, measurements  1 -> 1   (selected branch, unchanged)
--   S2  selected contractor, the claim's ESTIMATE object          1 -> 1   (selected branch, unchanged)
--   F1  test bidder, real open claim's estimate object            0 -> 0   (world fence, unchanged)
--   F2  test bidder, real open claim's measurements object        0 -> 0   (world fence, unchanged)
--   O1, O2  the claim owner, own estimate object                  1 -> 1
--   O3  a homeowner, another homeowner's estimate object          0 -> 0
--   AD  a session carrying an admin email, whole bucket           0 -> 0   (no storage policy names
--                                                                           admins; admin pages read
--                                                                           through the service role)
--   V1  service_role, whole bucket                                unchanged (27 objects on 2026-10-06)
--   A1  anon, whole bucket                                        0 -> 0
--   T-all  test bidder, whole bucket                              4 -> 3   (loses the one estimate)
--   R-all  real bidder, whole bucket                              3 -> 2   (loses the one estimate)
--   OTHER  md5 over every other policy on storage.objects: identical in every phase
DO $proof$
DECLARE
  v_fwd text := /*@FWD@*/ NULL /*@FWD@*/;
  v_rb  text := /*@RB@*/ NULL /*@RB@*/;
  c_pol constant text := 'Contractors can view biddable claim docs';
  k1 constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0';
  k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  k2 constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111';
  k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  k4 constant uuid := '5e76adc9-8bd9-4ab6-a8c6-6a083f70d102';
  k4u constant uuid := '901008b8-dc5d-4af4-ae6c-06f6305ed72f';
  o_test constant uuid := 'e6588b43-8866-45b5-98f3-6b4a06a651e8';
  o_real constant uuid := '10bc0bd2-eee7-4950-95fc-a50875ba28f3';
  out text := '';
  phase text;
  phases text[];
  r record;
  n bigint;
  v_wide boolean;
  v_narrow boolean;
  t text;
  sv_est text;
  sv_meas text;
BEGIN
  -- fixtures, as superuser, each in its own block so a refusal is reported and not fatal
  BEGIN
    UPDATE public.contractors SET is_test = false WHERE id = k2;
  EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE k2 is_test=false REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
  END;
  BEGIN
    UPDATE public.claims SET ready_for_bids = false, selected_contractor_id = k4
     WHERE id::text LIKE 'ba90c501-%';
  EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE S1 REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
  END;
  BEGIN
    UPDATE public.claims SET selected_contractor_id = k4 WHERE id::text LIKE 'f3bfb1f9-%';
  EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE S2 REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
  END;
  SELECT estimate_filename, measurements_filename INTO sv_est, sv_meas
    FROM public.claims WHERE id::text LIKE 'f3bfb1f9-%';

  SELECT 'FIXTURES contractors: ' || string_agg(left(id::text, 8) || ' is_test=' || is_test || ' ' || status, ' ; ' ORDER BY id)
    INTO t FROM public.contractors WHERE id IN (k1, k2, k4);
  out := out || t || E'\n';
  SELECT 'FIXTURES claims: ' || string_agg(left(c.id::text, 8) || ' is_test=' || c.is_test || ' ' || c.status
           || ' rfb=' || c.ready_for_bids || ' selected=' || coalesce(left(c.selected_contractor_id::text, 8), 'null')
           || ' fee=' || coalesce(c.platform_fee_charged::text, 'null')
           || ' est=' || (c.estimate_filename IS NOT NULL) || ' meas=' || (c.measurements_filename IS NOT NULL)
           || ' summary=' || (c.parsed_line_items IS NOT NULL AND c.contractor_scope_summary IS NOT NULL), ' ; ' ORDER BY c.id)
    INTO t FROM public.claims c
   WHERE left(c.id::text, 8) IN ('c5ebaa5d', '5c16cc1e', 'f3bfb1f9', '38ffb84a', 'ba90c501');
  out := out || t || E'\n';
  SELECT 'FIXTURES objects: ' || string_agg(left(o.id::text, 8) || ' claim=' || left(c.id::text, 8)
           || ' is_estimate=' || coalesce(o.name = c.estimate_filename, false)
           || ' is_measurements=' || coalesce(o.name = c.measurements_filename, false), ' ; ' ORDER BY o.id)
    INTO t FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents'
     AND left(o.id::text, 8) IN ('6f4cc57f', '58f2e18d', 'd34fdd63', 'f3fe8908', '4ce02f4b', '7be4f256');
  out := out || t || E'\n';

  phases := CASE WHEN v_fwd IS NULL THEN ARRAY['live'] ELSE ARRAY['live', 'after forward', 'after rollback'] END;

  FOREACH phase IN ARRAY phases LOOP
    IF phase = 'after forward' THEN EXECUTE v_fwd; END IF;
    IF phase = 'after rollback' THEN EXECUTE v_rb; END IF;

    out := out || E'\n== ' || phase || E' ==\n';
    SELECT 'POLICY roles=' || roles::text || ' cmd=' || cmd || ' qual=' || regexp_replace(qual, '\s+', ' ', 'g')
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = c_pol;
    out := out || coalesce(t, 'POLICY MISSING') || E'\n';
    SELECT 'OTHER policies on storage.objects: n=' || count(*) || ' md5=' ||
           md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname <> c_pol;
    out := out || t || E'\n';
    SELECT 'CLAIMS policies on public.claims: n=' || count(*) || ' md5=' ||
           md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
      INTO t FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims';
    out := out || t || E'\n';

    v_wide := true; v_narrow := true;
    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'B1 test bidder k1 -> test open claim f3bfb1f9 ESTIMATE object',            'authenticated', k1u, NULL, 'obj', '6f4cc57f', NULL, 1, 0),
        ( 2, 'B2 test bidder k1 -> test open claim 38ffb84a MEASUREMENTS object',        'authenticated', k1u, NULL, 'obj', '58f2e18d', NULL, 1, 1),
        ( 3, 'B3 test bidder k1 -> claim row f3bfb1f9 with its parsed summary',          'authenticated', k1u, NULL, 'sum', 'f3bfb1f9', NULL, 1, 1),
        ( 4, 'R1 real bidder k2 -> real open claim c5ebaa5d ESTIMATE object',            'authenticated', k2u, NULL, 'obj', 'f3fe8908', NULL, 1, 0),
        ( 5, 'R2 real bidder k2 -> real open claim c5ebaa5d MEASUREMENTS object',        'authenticated', k2u, NULL, 'obj', '4ce02f4b', NULL, 1, 1),
        ( 6, 'R3 real bidder k2 -> real open claim 5c16cc1e MEASUREMENTS object',        'authenticated', k2u, NULL, 'obj', '7be4f256', NULL, 1, 1),
        ( 7, 'R4 real bidder k2 -> claim row c5ebaa5d with its parsed summary',          'authenticated', k2u, NULL, 'sum', 'c5ebaa5d', NULL, 1, 1),
        ( 8, 'X1 test bidder k1 -> f3bfb1f9 estimate object, claim row names another',   'authenticated', k1u, NULL, 'obj', '6f4cc57f', 'supersede', 1, 0),
        ( 9, 'E1 test bidder k1 -> f3bfb1f9 object named in BOTH slots',                 'authenticated', k1u, NULL, 'obj', '6f4cc57f', 'sameslot', 1, 0),
        (10, 'S1 selected contractor k4 -> ba90c501 measurements, closed for bids',      'authenticated', k4u, NULL, 'obj', 'd34fdd63', NULL, 1, 1),
        (11, 'S2 selected contractor k4 -> f3bfb1f9 ESTIMATE object',                    'authenticated', k4u, NULL, 'obj', '6f4cc57f', NULL, 1, 1),
        (12, 'F1 test bidder k1 -> real open claim c5ebaa5d estimate object',            'authenticated', k1u, NULL, 'obj', 'f3fe8908', NULL, 0, 0),
        (13, 'F2 test bidder k1 -> real open claim c5ebaa5d measurements object',        'authenticated', k1u, NULL, 'obj', '4ce02f4b', NULL, 0, 0),
        (14, 'O1 owner of test claim f3bfb1f9 -> own estimate object',                   'authenticated', o_test, NULL, 'obj', '6f4cc57f', NULL, 1, 1),
        (15, 'O2 owner of real claim c5ebaa5d -> own estimate object',                   'authenticated', o_real, NULL, 'obj', 'f3fe8908', NULL, 1, 1),
        (16, 'O3 owner of real claim c5ebaa5d -> another homeowner''s estimate object',  'authenticated', o_real, NULL, 'obj', '6f4cc57f', NULL, 0, 0),
        (17, 'AD admin-email session -> whole claim-documents bucket',                   'authenticated', '00000000-0000-4000-8000-000000002559'::uuid, 'dustin@otterquote.com', 'obj', NULL, NULL, 0, 0),
        (18, 'T-all test bidder k1 -> whole claim-documents bucket',                     'authenticated', k1u, NULL, 'obj', NULL, NULL, 4, 3),
        (19, 'R-all real bidder k2 -> whole claim-documents bucket',                     'authenticated', k2u, NULL, 'obj', NULL, NULL, 3, 2),
        (20, 'V1 service_role -> whole claim-documents bucket',                          'service_role',  NULL::uuid, NULL, 'obj', NULL, NULL, 27, 27),
        (21, 'A1 anon -> whole claim-documents bucket',                                  'anon',          NULL::uuid, NULL, 'obj', NULL, NULL, 0, 0)
      ) AS s(ord, label, role, sub, email, kind, target, mut, wide, narrowed) ORDER BY ord
    LOOP
      -- one-read fixture changes, as superuser, put back straight after the read
      IF r.mut = 'supersede' THEN
        UPDATE public.claims SET estimate_filename = sv_est || '.superseded' WHERE id::text LIKE 'f3bfb1f9-%';
      ELSIF r.mut = 'sameslot' THEN
        UPDATE public.claims SET measurements_filename = sv_est WHERE id::text LIKE 'f3bfb1f9-%';
      END IF;

      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', coalesce(r.email, 'gh2559-proof@example.invalid'))::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        IF r.kind = 'sum' THEN
          EXECUTE 'SELECT count(*) FROM public.claims WHERE id::text LIKE $1 || ''-%'' AND parsed_line_items IS NOT NULL AND contractor_scope_summary IS NOT NULL'
            INTO n USING r.target;
        ELSE
          EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents'' AND ($1 IS NULL OR id::text LIKE $1 || ''-%'')'
            INTO n USING r.target;
        END IF;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : rows=' || n || '  (wide ' || r.wide || ', narrowed ' || r.narrowed || ')' || E'\n';
        v_wide := v_wide AND n = r.wide;
        v_narrow := v_narrow AND n = r.narrowed;
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
        v_wide := false; v_narrow := false;
      END;

      IF r.mut IS NOT NULL THEN
        UPDATE public.claims SET estimate_filename = sv_est, measurements_filename = sv_meas WHERE id::text LIKE 'f3bfb1f9-%';
      END IF;
    END LOOP;
    out := out || 'VERDICT ' || phase || ': ' ||
           CASE WHEN v_narrow THEN 'NARROWED' WHEN v_wide THEN 'WIDE' ELSE 'UNEXPECTED' END || E'\n';
  END LOOP;

  RAISE EXCEPTION E'gh2559 summary-only proof (rolled back)\n%', out USING ERRCODE = 'P0U01';
END
$proof$;
