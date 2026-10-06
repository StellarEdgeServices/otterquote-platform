-- gh-2559 proof: world-match fence on the storage policy "Contractors can view biddable claim docs"
-- (migration 20261006171024_gh2559_claim_docs_world_fence.sql).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last
-- action is a deliberate RAISE EXCEPTION, so every fixture write (and, in forward-rollback mode, the
-- policy DDL) rolls back whatever the client does. The findings are the exception text.
--   Run this file alone      : prints the matrix against whatever policy is live and a VERDICT line
--                              (UNFENCED before the migration, FENCED after it).
--   Forward-rollback mode    : replace the two NULLs between the @FWD@ and @RB@ markers with the body of
--                              the migration and of the rollback file, each dollar-quoted and with its
--                              BEGIN; and COMMIT; lines removed. The block then prints the matrix three
--                              times: live, after the forward DDL, after the rollback DDL. That is how
--                              the PR's proof was produced before the migration was applied.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read.
-- Each line is: how many rows of storage.objects the caller can SELECT for ONE named object id
-- (or, for the "all" lines, for the whole claim-documents bucket). File contents are never read.
--
-- Fixtures (production ids, read 2026-10-06; the FIXTURES line prints their live flags):
--   k1  contractor 986ce2b6, login d4def812: is_test, active. The test-world contractor.
--   k2  contractor bb07fc40, login 189b85ad: is_test, active. The block sets is_test = false on it as
--       superuser (rolled back), which makes it the real-world contractor. Production has no active
--       is_test = false contractor to use instead.
--   real claims open for bids: c5ebaa5d (object 4ce02f4b), 5c16cc1e (object 7be4f256)
--   real claim, draft, not open: 4595b6f0 (object 72e55b64)
--   test claim open for bids: 38ffb84a (object 58f2e18d, owner login 6b183fbd)
--   k3  contractor 848798cc, login ce69bf9d: is_test, active, with a submitted bid on test claim
--       38ffb84a. The block sets is_test = false on it too (rolled back). Because of its bid, the claims
--       policy "Contractors can view claims for their quotes" shows it the test claim's row, so it is a
--       real-world contractor that reaches a test claim's files through the bidding leg (line R3).
--   k4  contractor 5e76adc9, login 901008b8: is_test, active, with a bid on test claim ba90c501
--       (object d34fdd63). The block closes that claim for bids and selects k4 on it (rolled back), so
--       k4 reaches the file only through the selected-contractor branch (line S1).
--   owner of real claim c5ebaa5d: login 10bc0bd2.
--
-- Expected, UNFENCED -> FENCED (everything else must be identical):
--   T1, T2  test contractor, real open claim's object     1 -> 0   (the hole)
--   R2      real contractor, real open claim's object     1 -> 1
--   T3      test contractor, test open claim's object     1 -> 1
--   R1      real contractor, test open claim's object     0 -> 0   (the claims-table fence already hides
--                                                                   test claims from real contractors)
--   R3      real contractor with a bid on a test claim,
--           that test claim's object                      1 -> 0   (the same hole, other direction)
--   T4      test contractor, real draft claim's object    0 -> 0
--   S1      selected contractor, claim closed for bids    1 -> 1   (selected-contractor branch, unchanged)
--   O1, O2  the claim owner, own object                   1 -> 1
--   O3      a homeowner, another homeowner's object       0 -> 0
--   V1      service_role, whole bucket                    unchanged (27 objects on 2026-10-06)
--   A1      anon, whole bucket                            0 -> 0
--   T-all   test contractor, whole bucket                 7 -> 4   (loses the 3 objects of the 2 real open claims)
--   R-all   real contractor, whole bucket                 3 -> 3
--   OTHER   md5 over every other policy on storage.objects: identical in every phase
DO $proof$
DECLARE
  v_fwd text := /*@FWD@*/ NULL /*@FWD@*/;
  v_rb  text := /*@RB@*/ NULL /*@RB@*/;
  c_pol constant text := 'Contractors can view biddable claim docs';
  k1 constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0';
  k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  k2 constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111';
  k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  k3 constant uuid := '848798cc-217c-44a5-83f3-c82b3c602452';
  k3u constant uuid := 'ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c';
  k4 constant uuid := '5e76adc9-8bd9-4ab6-a8c6-6a083f70d102';
  k4u constant uuid := '901008b8-dc5d-4af4-ae6c-06f6305ed72f';
  out text := '';
  phase text;
  phases text[];
  r record;
  n bigint;
  v_unf boolean;
  v_fen boolean;
  t text;
BEGIN
  -- fixtures, as superuser, each in its own block so a refusal is reported and not fatal
  BEGIN
    UPDATE public.contractors SET is_test = false WHERE id IN (k2, k3);
  EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE k2, k3 is_test=false REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
  END;
  BEGIN
    UPDATE public.claims SET ready_for_bids = false, selected_contractor_id = k4
     WHERE id::text LIKE 'ba90c501-%';
  EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE S1 REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
  END;

  SELECT 'FIXTURES contractors: ' || string_agg(left(id::text, 8) || ' is_test=' || is_test || ' ' || status, ' ; ' ORDER BY id)
    INTO t FROM public.contractors WHERE id IN (k1, k2, k3, k4);
  out := out || t || E'\n';
  SELECT 'FIXTURES claims: ' || string_agg(left(c.id::text, 8) || ' is_test=' || c.is_test || ' ' || c.status
           || ' rfb=' || c.ready_for_bids || ' selected=' || coalesce(left(c.selected_contractor_id::text, 8), 'null'), ' ; ' ORDER BY c.id)
    INTO t FROM public.claims c
   WHERE left(c.id::text, 8) IN ('c5ebaa5d', '5c16cc1e', '4595b6f0', '38ffb84a', 'ba90c501');
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

    v_unf := true; v_fen := true;
    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'T1 test contractor k1 -> real open claim c5ebaa5d object',          'authenticated', k1u, '4ce02f4b', 1, 0),
        ( 2, 'T2 test contractor k1 -> real open claim 5c16cc1e object',          'authenticated', k1u, '7be4f256', 1, 0),
        ( 3, 'R2 real contractor k2 -> real open claim c5ebaa5d object',          'authenticated', k2u, '4ce02f4b', 1, 1),
        ( 4, 'T3 test contractor k1 -> test open claim 38ffb84a object',          'authenticated', k1u, '58f2e18d', 1, 1),
        ( 5, 'R1 real contractor k2 -> test open claim 38ffb84a object',          'authenticated', k2u, '58f2e18d', 0, 0),
        ( 6, 'T4 test contractor k1 -> real draft claim 4595b6f0 object',         'authenticated', k1u, '72e55b64', 0, 0),
        ( 7, 'R3 real contractor k3, bid on test claim 38ffb84a -> its object',   'authenticated', k3u, '58f2e18d', 1, 0),
        ( 8, 'S1 selected contractor k4 -> claim ba90c501 object, closed for bids','authenticated', k4u, 'd34fdd63', 1, 1),
        ( 9, 'O1 owner of real claim c5ebaa5d -> own object',                     'authenticated', '10bc0bd2-eee7-4950-95fc-a50875ba28f3'::uuid, '4ce02f4b', 1, 1),
        (10, 'O2 owner of test claim 38ffb84a -> own object',                     'authenticated', '6b183fbd-ff7e-4906-86f6-8e5a4f0c4153'::uuid, '58f2e18d', 1, 1),
        (11, 'O3 owner of real claim c5ebaa5d -> another homeowner''s object',    'authenticated', '10bc0bd2-eee7-4950-95fc-a50875ba28f3'::uuid, '58f2e18d', 0, 0),
        (12, 'T-all test contractor k1 -> whole claim-documents bucket',          'authenticated', k1u, NULL, 7, 4),
        (13, 'R-all real contractor k2 -> whole claim-documents bucket',          'authenticated', k2u, NULL, 3, 3),
        (14, 'V1 service_role -> whole claim-documents bucket',                   'service_role',  NULL::uuid, NULL, 27, 27),
        (15, 'A1 anon -> whole claim-documents bucket',                           'anon',          NULL::uuid, NULL, 0, 0)
      ) AS s(ord, label, role, sub, obj, unfenced, fenced) ORDER BY ord
    LOOP
      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', 'gh2559-proof@example.invalid')::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents'' AND ($1 IS NULL OR id::text LIKE $1 || ''-%'')'
          INTO n USING r.obj;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : rows=' || n
               || CASE WHEN r.unfenced IS NOT NULL THEN '  (unfenced ' || r.unfenced || ', fenced ' || r.fenced || ')' ELSE '' END || E'\n';
        IF r.unfenced IS NOT NULL THEN
          v_unf := v_unf AND n = r.unfenced;
          v_fen := v_fen AND n = r.fenced;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
        v_unf := false; v_fen := false;
      END;
    END LOOP;
    out := out || 'VERDICT ' || phase || ': ' ||
           CASE WHEN v_fen THEN 'FENCED' WHEN v_unf THEN 'UNFENCED' ELSE 'UNEXPECTED' END || E'\n';
  END LOOP;

  RAISE EXCEPTION E'gh2559 proof (rolled back)\n%', out USING ERRCODE = 'P0U01';
END
$proof$;
