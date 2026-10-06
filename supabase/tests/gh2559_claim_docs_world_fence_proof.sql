-- gh-2559 proof: world-match fence on the storage policy "Contractors can view biddable claim docs"
-- (migration 20261006171747_gh2559_claim_docs_world_fence.sql).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last
-- action is a deliberate RAISE EXCEPTION, so every fixture write (and, in forward-rollback mode, the
-- policy DDL) rolls back whatever the client does. The findings are the exception text.
--   Run this file alone      : prints the matrix against whatever policy is live and a VERDICT line
--                              (UNFENCED before the migration, FENCED after it).
--   Forward-rollback mode    : replace the two NULLs between the @FWD@ and @RB@ markers with the body of
--                              the migration and of the rollback file, each dollar-quoted and with its
--                              BEGIN; and COMMIT; lines removed. The block then prints the matrix three
--                              times: live, after the forward DDL, after the rollback DDL.
--   Negative control         : the "after rollback" phase of that mode IS the control. With the fence
--                              removed the cross-world lines (T1, T2, R3, T-real) read rows.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read.
-- Each line is: how many rows of storage.objects the caller can SELECT for ONE named object (or, for the
-- "real" and "all" lines, for a set of objects). File contents are never read.
--
-- NO IDENTIFIERS ARE WRITTEN IN THIS FILE. Every fixture is looked up at run time (the FIXTURES lines
-- print what was found, as 8-character prefixes, in the output only):
--   cl_ro  a claim flagged real (is_test = false), open for bids, that has a file in claim-documents
--   cl_to  a claim flagged test, open for bids, that has a file
--   cl_rd  a claim flagged real, NOT open for bids, that has a file
--   cl_s   a further claim with a file and a quote from an active contractor (used for line S1)
--   k1, k2 two active test-flagged contractors with a login and no quote on cl_to. k2 is set to
--          is_test = false as superuser (rolled back): it is the real-world contractor.
--   k3     an active test-flagged contractor with a login and a quote on cl_to, set to is_test = false
--          (rolled back). Its quote lets the claims policy show it cl_to's row, so it reaches cl_to's
--          file through the bidding leg (line R3).
--   k4     an active contractor with a login and a quote on cl_s (its quote is what lets the claims
--          policy show it the row). The block closes cl_s for bids and selects k4 on it (rolled back),
--          so k4 reaches the file only through the selected-contractor branch (S1). k4 may be the same
--          contractor as k1; the block changes only cl_s for it.
-- A line whose fixture does not exist today prints NO FIXTURE and the verdict becomes INCOMPLETE, never
-- FENCED. Expected counts per line are fixed by the policy; the "real" lines compute theirs from the data.
--
-- Expected, UNFENCED -> FENCED (everything else must be identical):
--   T1      test contractor k1, cl_ro's file              1 -> 0   (the hole)
--   R2      real contractor k2, cl_ro's file              1 -> 1
--   T3      test contractor k1, cl_to's file              1 -> 1
--   R1      real contractor k2, cl_to's file              0 -> 0
--   R3      real contractor k3 (quote on cl_to), cl_to    1 -> 0   (the same hole, other direction)
--   T4      test contractor k1, cl_rd's file              0 -> 0
--   S1      selected contractor k4, claim closed          1 -> 1   (selected-contractor branch)
--   O1, O2  the claim owner, own file                     1 -> 1
--   O3      one owner, another owner's file               0 -> 0
--   T-real  k1, every file of every open real claim       n -> 0   (n computed from the data)
--   R-real  k2, the same set                              n -> n
--   V1      service_role, whole bucket                    unchanged (computed)
--   A1      anon, whole bucket                            0 -> 0
--   OTHER   md5 over every other policy on storage.objects: identical in every phase
DO $proof$
DECLARE
  v_fwd text := /*@FWD@*/ NULL /*@FWD@*/;
  v_rb  text := /*@RB@*/ NULL /*@RB@*/;
  c_pol constant text := 'Contractors can view biddable claim docs';
  k1 uuid; k1u uuid; k2 uuid; k2u uuid; k3 uuid; k3u uuid; k4 uuid; k4u uuid;
  cl_ro uuid; cl_to uuid; cl_rd uuid; cl_s uuid;
  o_ro uuid; o_to uuid; o_rd uuid; o_s uuid;
  w_ro uuid; w_to uuid;
  real_k1 uuid[]; real_k2 uuid[];
  n_bucket bigint;
  out text := '';
  phase text;
  phases text[];
  md5s text[] := ARRAY[]::text[];
  r record;
  n bigint;
  v_unf boolean;
  v_fen boolean;
  v_inc boolean;
  v_md5 boolean := true;
  t text;
BEGIN
  -- ---- fixture lookup, as superuser, nothing hard-coded ----
  SELECT o.id, c.id, (storage.foldername(o.name))[1]::uuid INTO o_ro, cl_ro, w_ro
    FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents' AND c.is_test = false AND c.ready_for_bids = true
     AND c.status IN ('active', 'bidding', 'pending') AND (storage.foldername(o.name))[1] ~ '^[0-9a-f-]{36}$'
   ORDER BY o.id LIMIT 1;
  SELECT o.id, c.id, (storage.foldername(o.name))[1]::uuid INTO o_to, cl_to, w_to
    FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents' AND c.is_test = true AND c.ready_for_bids = true
     AND c.status IN ('active', 'bidding', 'pending') AND (storage.foldername(o.name))[1] ~ '^[0-9a-f-]{36}$'
   ORDER BY o.id LIMIT 1;
  SELECT o.id, c.id INTO o_rd, cl_rd
    FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents' AND c.is_test = false
     AND NOT (c.ready_for_bids = true AND c.status IN ('active', 'bidding', 'pending'))
   ORDER BY o.id LIMIT 1;
  SELECT k.id, k.user_id INTO k1, k1u FROM public.contractors k
   WHERE k.status = 'active' AND k.is_test = true AND k.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = k.id AND q.claim_id = cl_to)
   ORDER BY k.id LIMIT 1;
  SELECT k.id, k.user_id INTO k2, k2u FROM public.contractors k
   WHERE k.status = 'active' AND k.is_test = true AND k.user_id IS NOT NULL AND k.id <> k1
     AND k.user_id <> k1u
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = k.id AND q.claim_id = cl_to)
   ORDER BY k.id LIMIT 1;
  SELECT k.id, k.user_id INTO k3, k3u FROM public.contractors k
   WHERE k.status = 'active' AND k.is_test = true AND k.user_id IS NOT NULL AND k.id <> k1 AND k.id <> k2
     AND k.user_id <> k1u AND k.user_id <> k2u
     AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = k.id AND q.claim_id = cl_to)
   ORDER BY k.id LIMIT 1;
  SELECT c.id, o.id, k.id, k.user_id INTO cl_s, o_s, k4, k4u
    FROM public.quotes q
    JOIN public.claims c ON c.id = q.claim_id
    JOIN public.contractors k ON k.id = q.contractor_id AND k.status = 'active' AND k.user_id IS NOT NULL
    JOIN storage.objects o ON o.bucket_id = 'claim-documents' AND (storage.foldername(o.name))[2] = c.id::text
   WHERE c.id IS DISTINCT FROM cl_ro AND c.id IS DISTINCT FROM cl_to AND c.id IS DISTINCT FROM cl_rd
   ORDER BY c.id, k.id, o.id LIMIT 1;

  -- ---- fixture writes, as superuser, each in its own block so a refusal is reported and not fatal ----
  IF k2 IS NOT NULL OR k3 IS NOT NULL THEN
    BEGIN
      UPDATE public.contractors SET is_test = false WHERE id IN (coalesce(k2, k3), coalesce(k3, k2));
    EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE is_test=false REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
    END;
  END IF;
  IF cl_s IS NOT NULL AND k4 IS NOT NULL THEN
    BEGIN
      UPDATE public.claims SET ready_for_bids = false, selected_contractor_id = k4 WHERE id = cl_s;
    EXCEPTION WHEN OTHERS THEN out := out || 'FIXTURE S1 REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
    END;
  END IF;

  -- objects of open real claims, computed AFTER the fixture writes: what k1 and k2 could read if unfenced
  SELECT coalesce(array_agg(o.id), ARRAY[]::uuid[]) INTO real_k1
    FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents' AND c.is_test = false AND c.ready_for_bids = true
     AND c.status IN ('active', 'bidding', 'pending') AND c.selected_contractor_id IS DISTINCT FROM k1;
  SELECT coalesce(array_agg(o.id), ARRAY[]::uuid[]) INTO real_k2
    FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
   WHERE o.bucket_id = 'claim-documents' AND c.is_test = false AND c.ready_for_bids = true
     AND c.status IN ('active', 'bidding', 'pending');
  SELECT count(*) INTO n_bucket FROM storage.objects WHERE bucket_id = 'claim-documents';

  out := out || 'FIXTURES found (prefixes): k1=' || coalesce(left(k1::text, 8), 'NONE') || ' k2=' || coalesce(left(k2::text, 8), 'NONE')
         || ' k3=' || coalesce(left(k3::text, 8), 'NONE') || ' k4=' || coalesce(left(k4::text, 8), 'NONE')
         || ' cl_ro=' || coalesce(left(cl_ro::text, 8), 'NONE') || ' cl_to=' || coalesce(left(cl_to::text, 8), 'NONE')
         || ' cl_rd=' || coalesce(left(cl_rd::text, 8), 'NONE') || ' cl_s=' || coalesce(left(cl_s::text, 8), 'NONE') || E'\n';
  SELECT 'FIXTURES contractors: ' || coalesce(string_agg('is_test=' || is_test || ' ' || status, ' ; ' ORDER BY id), 'none')
    INTO t FROM public.contractors WHERE id IN (k1, k2, k3, k4);
  out := out || t || E'\n';
  SELECT 'FIXTURES claims: ' || coalesce(string_agg('is_test=' || c.is_test || ' ' || c.status || ' rfb=' || c.ready_for_bids
           || ' selected=' || (c.selected_contractor_id IS NOT NULL), ' ; ' ORDER BY c.id), 'none')
    INTO t FROM public.claims c WHERE c.id IN (cl_ro, cl_to, cl_rd, cl_s);
  out := out || t || E'\n';
  out := out || 'FIXTURES bucket objects=' || n_bucket || ' open-real objects for k1=' || cardinality(real_k1)
         || ' for k2=' || cardinality(real_k2) || E'\n';

  phases := CASE WHEN v_fwd IS NULL THEN ARRAY['live'] ELSE ARRAY['live', 'after forward', 'after rollback'] END;

  FOREACH phase IN ARRAY phases LOOP
    IF phase = 'after forward' THEN EXECUTE v_fwd; END IF;
    IF phase = 'after rollback' THEN EXECUTE v_rb; END IF;

    out := out || E'\n== ' || phase || E' ==\n';
    SELECT 'POLICY roles=' || roles::text || ' cmd=' || cmd || ' qual=' || regexp_replace(qual, '\s+', ' ', 'g')
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = c_pol;
    out := out || coalesce(t, 'POLICY MISSING') || E'\n';
    SELECT md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname <> c_pol;
    md5s := md5s || t;
    out := out || 'OTHER policies on storage.objects md5=' || t || E'\n';

    v_unf := true; v_fen := true; v_inc := false;
    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'T1 test contractor k1 -> real open claim file',               'authenticated', k1u, o_ro, NULL::uuid[], 1::bigint, 0::bigint, k1 IS NOT NULL AND o_ro IS NOT NULL),
        ( 2, 'R2 real contractor k2 -> real open claim file',               'authenticated', k2u, o_ro, NULL, 1, 1, k2 IS NOT NULL AND o_ro IS NOT NULL),
        ( 3, 'T3 test contractor k1 -> test open claim file',               'authenticated', k1u, o_to, NULL, 1, 1, k1 IS NOT NULL AND o_to IS NOT NULL),
        ( 4, 'R1 real contractor k2 -> test open claim file',               'authenticated', k2u, o_to, NULL, 0, 0, k2 IS NOT NULL AND o_to IS NOT NULL),
        ( 5, 'T4 test contractor k1 -> real closed claim file',             'authenticated', k1u, o_rd, NULL, 0, 0, k1 IS NOT NULL AND o_rd IS NOT NULL),
        ( 6, 'R3 real contractor k3, quote on test claim -> its file',      'authenticated', k3u, o_to, NULL, 1, 0, k3 IS NOT NULL AND o_to IS NOT NULL),
        ( 7, 'S1 selected contractor k4 -> claim closed for bids',          'authenticated', k4u, o_s,  NULL, 1, 1, k4 IS NOT NULL AND o_s IS NOT NULL),
        ( 8, 'O1 owner of real open claim -> own file',                     'authenticated', w_ro, o_ro, NULL, 1, 1, w_ro IS NOT NULL AND o_ro IS NOT NULL),
        ( 9, 'O2 owner of test open claim -> own file',                     'authenticated', w_to, o_to, NULL, 1, 1, w_to IS NOT NULL AND o_to IS NOT NULL),
        (10, 'O3 owner of real open claim -> the other owner''s file',      'authenticated', w_ro, o_to, NULL, 0, 0, w_ro IS NOT NULL AND o_to IS NOT NULL AND w_ro IS DISTINCT FROM w_to),
        (11, 'T-real test contractor k1 -> every open real claim file',     'authenticated', k1u, NULL, real_k1, cardinality(real_k1)::bigint, 0, k1 IS NOT NULL AND cardinality(real_k1) > 0),
        (12, 'R-real real contractor k2 -> every open real claim file',     'authenticated', k2u, NULL, real_k2, cardinality(real_k2)::bigint, cardinality(real_k2)::bigint, k2 IS NOT NULL AND cardinality(real_k2) > 0),
        (13, 'V1 service_role -> whole claim-documents bucket',             'service_role',  NULL::uuid, NULL, NULL, n_bucket, n_bucket, true),
        (14, 'A1 anon -> whole claim-documents bucket',                     'anon',          NULL::uuid, NULL, NULL, 0, 0, true)
      ) AS s(ord, label, role, sub, obj, objs, unfenced, fenced, have) ORDER BY ord
    LOOP
      IF NOT r.have THEN
        out := out || r.label || ' : NO FIXTURE' || E'\n';
        v_inc := true;
        CONTINUE;
      END IF;
      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', 'gh2559-proof@example.invalid')::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        IF r.obj IS NOT NULL THEN
          SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'claim-documents' AND id = r.obj;
        ELSIF r.objs IS NOT NULL THEN
          SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'claim-documents' AND id = ANY (r.objs);
        ELSE
          SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'claim-documents';
        END IF;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : rows=' || n || '  (unfenced ' || r.unfenced || ', fenced ' || r.fenced || ')' || E'\n';
        v_unf := v_unf AND n = r.unfenced;
        v_fen := v_fen AND n = r.fenced;
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
        v_unf := false; v_fen := false;
      END;
    END LOOP;
    out := out || 'VERDICT ' || phase || ': ' ||
           CASE WHEN v_inc THEN 'INCOMPLETE (a fixture is missing)' WHEN v_fen THEN 'FENCED' WHEN v_unf THEN 'UNFENCED' ELSE 'UNEXPECTED' END || E'\n';
  END LOOP;

  SELECT bool_and(m = md5s[1]) INTO v_md5 FROM unnest(md5s) AS m;
  out := out || E'\nOTHER-POLICIES identical in every phase: ' || v_md5 || E'\n';

  RAISE EXCEPTION E'gh2559 proof (rolled back)\n%', out USING ERRCODE = 'P0U01';
END
$proof$;
