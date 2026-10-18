-- gh-2559 fee leg proof: D-386 gate on the storage policy "Contractors can view biddable claim docs"
-- (supabase/migrations/20261018193726_gh2559_claim_docs_fee_gate.sql; NOT APPLIED when this was written).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last action is a
-- deliberate RAISE EXCEPTION, so every fixture write and the DDL roll back whatever the client does. The findings are
-- the exception text. It INSERTs nothing (no storage object, no sequence use); its only writes are three UPDATEs of one
-- is_test claim (selected_contractor_id, platform_fee_charged) made as the database owner, all undone by the rollback.
-- The text between the $fwd$ and $rb$ markers is the body of the forward and of the rollback file without their
-- header comments and BEGIN/COMMIT lines (tests/gh2559-claim-docs-fee-gate.mjs fails if they drift from the files).
-- Phases: live -> after forward -> after rollback (the block prints the matrix three times).
-- FIXTURES ARE is_test ONLY, FOUND AT RUN TIME (no identifier is in this file), and the block FAILS CLOSED:
--   cE   test claim open for bids, with an estimate object in its own folder, owned by an is_test profile
--   kS   active is_test contractor that owns no claim and is selected nowhere: the block selects it on cE (rolled back)
--   kN   another such contractor: an active bidder who is NOT the selected one
--   ownE the claim owner of cE (is_test profile)
-- If any fixture is missing, or is not is_test (claim, owner profile, either contractor), the block raises with
-- ERRCODE P0U02 before it changes or reads anything. Real rows are never addressed.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read. Rows are counted;
-- file contents are never read.
-- Expected, LIVE (before) -> GATED (after forward); the after-rollback column must equal LIVE:
--   C1  selected contractor kS, fee false     -> cE estimate object       1 -> 0   (the change: allowed before, refused after)
--   C2  selected contractor kS, fee NULL      -> cE estimate object       1 -> 0   (NULL is not collected)
--   C3  selected contractor kS, fee true       -> cE estimate object       1 -> 1   (fee collected: allowed)
--   C4  non-selected bidder kN, fee false     -> cE estimate object       0 -> 0   (refused both)
--   C5  non-selected bidder kN, fee true      -> cE estimate object       0 -> 0   (a fee on someone else's selection opens nothing)
--   C6  claim owner ownE, fee false           -> own estimate object      1 -> 1   (homeowner always allowed)
--   C7  claim owner ownE, fee true            -> own estimate object      1 -> 1
--   C8  selected kS, fee false, whole bucket  -> oracle count             n -> 0
--   C9  selected kS, fee true, whole bucket   -> oracle count             n -> n
--   V1  service_role, whole bucket            unchanged       A1  anon, whole bucket   0 -> 0
--   OTHER  md5 of every other policy on storage.objects, of the public.claims policies and of the public.claims
--          triggers: identical in every phase.
DO $proof$
DECLARE
  v_fwd text := $fwd$
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view biddable claim docs" ON storage.objects;

CREATE POLICY "Contractors can view biddable claim docs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-documents'
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    JOIN public.contractors ct
      ON ct.user_id = auth.uid()
     AND ct.status = 'active'
    WHERE c.id::text = (storage.foldername(objects.name))[2]
      AND c.selected_contractor_id = ct.id
      AND c.platform_fee_charged IS TRUE
  )
);

DO $check$
DECLARE
  v_qual text;
BEGIN
  SELECT qual INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Contractors can view biddable claim docs';
  IF v_qual IS NULL OR v_qual NOT LIKE '%platform_fee_charged%' OR v_qual NOT LIKE '%selected_contractor_id%' THEN
    RAISE EXCEPTION 'gh2559 fee gate: policy missing or without the fee / selected conditions' USING ERRCODE = 'P0A03';
  END IF;
END
$check$;
$fwd$;
  v_rb  text := $rb$
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view biddable claim docs" ON storage.objects;

CREATE POLICY "Contractors can view biddable claim docs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-documents'
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    JOIN public.contractors ct
      ON ct.user_id = auth.uid()
     AND ct.status = 'active'
    WHERE c.id::text = (storage.foldername(objects.name))[2]
      AND c.selected_contractor_id = ct.id
  )
);
$rb$;
  c_pol constant text := 'Contractors can view biddable claim docs';
  kS uuid; kSu uuid; kN uuid; kNu uuid; cE uuid; ownE uuid; oidE uuid;
  out text := '';
  phase text;
  r record;
  n bigint;
  t text;
  v_live boolean; v_gated boolean;
  exp_live bigint; exp_gated bigint;
BEGIN
  -- ---------------------------------------------------------------- fixture lookup (database owner), is_test only
  SELECT c.id, c.user_id INTO cE, ownE
    FROM public.claims c
    JOIN public.profiles p ON p.id = c.user_id AND p.is_test IS TRUE
   WHERE c.is_test IS TRUE AND c.ready_for_bids IS TRUE AND c.status IN ('active', 'bidding', 'pending')
     AND c.selected_contractor_id IS NULL AND c.estimate_filename IS NOT NULL
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'claim-documents' AND o.name = c.estimate_filename
                    AND (storage.foldername(o.name))[2] = c.id::text)
   ORDER BY c.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kS, kSu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test IS TRUE AND ct.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kN, kNu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test IS TRUE AND ct.user_id IS NOT NULL AND ct.id <> kS
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT o.id INTO oidE FROM storage.objects o JOIN public.claims c ON c.id = cE AND o.name = c.estimate_filename AND o.bucket_id = 'claim-documents';

  IF cE IS NULL OR kS IS NULL OR kN IS NULL OR ownE IS NULL OR oidE IS NULL THEN
    RAISE EXCEPTION 'gh2559 fee-gate proof: FIXTURE MISSING cE=% kS=% kN=% owner=% object=%',
      cE IS NOT NULL, kS IS NOT NULL, kN IS NOT NULL, ownE IS NOT NULL, oidE IS NOT NULL USING ERRCODE = 'P0U02';
  END IF;
  -- FAIL CLOSED: every fixture must be is_test, checked again from the tables themselves.
  IF (SELECT is_test FROM public.claims WHERE id = cE) IS NOT TRUE
     OR (SELECT is_test FROM public.profiles WHERE id = ownE) IS NOT TRUE
     OR (SELECT is_test FROM public.contractors WHERE id = kS) IS NOT TRUE
     OR (SELECT is_test FROM public.contractors WHERE id = kN) IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2559 fee-gate proof: FIXTURE NOT is_test (claim=% owner=% kS=% kN=%) - refusing to run',
      (SELECT is_test FROM public.claims WHERE id = cE), (SELECT is_test FROM public.profiles WHERE id = ownE),
      (SELECT is_test FROM public.contractors WHERE id = kS), (SELECT is_test FROM public.contractors WHERE id = kN)
      USING ERRCODE = 'P0U02';
  END IF;

  -- ---------------------------------------------------------------- fixture change (rolled back)
  UPDATE public.claims SET selected_contractor_id = kS, platform_fee_charged = false WHERE id = cE;

  out := out || 'FIXTURES (flags only, no ids): claim is_test=' || (SELECT is_test FROM public.claims WHERE id = cE)
    || ' status=' || (SELECT status FROM public.claims WHERE id = cE)
    || ' ready_for_bids=' || (SELECT ready_for_bids FROM public.claims WHERE id = cE)
    || ' owner is_test=' || (SELECT is_test FROM public.profiles WHERE id = ownE)
    || ' ; kS selected is_test=' || (SELECT is_test FROM public.contractors WHERE id = kS) || ' status=' || (SELECT status FROM public.contractors WHERE id = kS)
    || ' ; kN bidder is_test=' || (SELECT is_test FROM public.contractors WHERE id = kN) || ' status=' || (SELECT status FROM public.contractors WHERE id = kN)
    || E'\n';

  FOREACH phase IN ARRAY ARRAY['live', 'after forward', 'after rollback'] LOOP
    IF phase = 'after forward' THEN EXECUTE v_fwd; END IF;
    IF phase = 'after rollback' THEN EXECUTE v_rb; END IF;

    out := out || E'\n== ' || phase || E' ==\n';
    SELECT 'POLICY roles=' || roles::text || ' cmd=' || cmd || ' qual_md5=' || left(md5(qual), 8) || '...  selected_leg=' || (qual LIKE '%selected_contractor_id%')
           || ' fee_leg=' || (qual LIKE '%platform_fee_charged%') || ' bidding_leg=' || (qual LIKE '%ready_for_bids%')
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = c_pol;
    out := out || coalesce(t, 'POLICY MISSING') || E'\n';
    SELECT 'OTHER policies on storage.objects: n=' || count(*) || ' md5=' || left(md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)), 8) || '...'
      INTO t FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname <> c_pol;
    out := out || t || E'\n';
    SELECT 'CLAIMS policies on public.claims: n=' || count(*) || ' md5=' || left(md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)), 8) || '...'
      INTO t FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims';
    out := out || t || E'\n';
    SELECT 'TRIGGERS on public.claims: n=' || count(*) || ' fee_guard_present=' || coalesce(bool_or(tgname = 'claims_guard_platform_fee_charged'), false)
           || ' md5=' || left(md5(string_agg(pg_get_triggerdef(oid), E'\n' ORDER BY tgname)), 8) || '...'
      INTO t FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND NOT tgisinternal;
    out := out || t || E'\n';

    v_live := true; v_gated := true;
    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'C1 selected kS, fee FALSE  -> cE estimate object',            'authenticated', kSu, 'fee_false', 'obj',   oidE,        1, 0),
        ( 2, 'C2 selected kS, fee NULL   -> cE estimate object',            'authenticated', kSu, 'fee_null',  'obj',   oidE,        1, 0),
        ( 3, 'C3 selected kS, fee TRUE   -> cE estimate object',            'authenticated', kSu, 'fee_true',  'obj',   oidE,        1, 1),
        ( 4, 'C4 non-selected kN, fee FALSE -> cE estimate object',         'authenticated', kNu, 'fee_false', 'obj',   oidE,        0, 0),
        ( 5, 'C5 non-selected kN, fee TRUE  -> cE estimate object',         'authenticated', kNu, 'fee_true',  'obj',   oidE,        0, 0),
        ( 6, 'C6 claim owner, fee FALSE  -> own estimate object',           'authenticated', ownE, 'fee_false', 'obj',  oidE,        1, 1),
        ( 7, 'C7 claim owner, fee TRUE   -> own estimate object',           'authenticated', ownE, 'fee_true',  'obj',  oidE,        1, 1),
        ( 8, 'C8 selected kS, fee FALSE  -> whole bucket (oracle count)',   'authenticated', kSu, 'fee_false', 'ball',  NULL::uuid, -1, -1),
        ( 9, 'C9 selected kS, fee TRUE   -> whole bucket (oracle count)',   'authenticated', kSu, 'fee_true',  'ball',  NULL,       -1, -1),
        (10, 'V1 service_role            -> whole bucket',                  'service_role',  NULL::uuid, 'fee_false', 'objall', NULL,   -1, -1),
        (11, 'A1 anon                    -> whole bucket',                  'anon',          NULL::uuid, 'fee_false', 'obj',    NULL,    0, 0)
      ) AS s(ord, label, role, sub, mut, kind, target, live, gated) ORDER BY ord
    LOOP
      exp_live := r.live; exp_gated := r.gated;

      -- fee state for this read, set as the database owner (the gh2491 guard only refuses anon/authenticated)
      IF r.mut = 'fee_true' THEN UPDATE public.claims SET platform_fee_charged = true WHERE id = cE;
      ELSIF r.mut = 'fee_false' THEN UPDATE public.claims SET platform_fee_charged = false WHERE id = cE;
      ELSIF r.mut = 'fee_null' THEN UPDATE public.claims SET platform_fee_charged = NULL WHERE id = cE;
      END IF;

      -- oracle counts, computed as the owner before any role switch
      IF r.kind = 'objall' THEN
        SELECT count(*) INTO exp_live FROM storage.objects WHERE bucket_id = 'claim-documents'; exp_gated := exp_live;
      ELSIF r.kind = 'ball' THEN
        SELECT count(*) INTO exp_live FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
          JOIN public.contractors ct ON ct.id = kS AND ct.status = 'active'
         WHERE o.bucket_id = 'claim-documents' AND c.selected_contractor_id = ct.id;
        SELECT count(*) INTO exp_gated FROM storage.objects o JOIN public.claims c ON c.id::text = (storage.foldername(o.name))[2]
          JOIN public.contractors ct ON ct.id = kS AND ct.status = 'active'
         WHERE o.bucket_id = 'claim-documents' AND c.selected_contractor_id = ct.id AND c.platform_fee_charged IS TRUE;
      END IF;

      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', 'gh2559-feegate-proof@example.invalid')::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        IF r.kind IN ('objall', 'ball') THEN
          EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents''' INTO n;
        ELSE
          EXECUTE 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''claim-documents'' AND ($1 IS NULL OR id = $1)' INTO n USING r.target;
        END IF;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : rows=' || n || '  (live ' || exp_live || ', gated ' || exp_gated || ')' || E'\n';
        v_live := v_live AND n = exp_live;
        v_gated := v_gated AND n = exp_gated;
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n';
        v_live := false; v_gated := false;
      END;
    END LOOP;
    out := out || 'VERDICT ' || phase || ': ' ||
           CASE WHEN v_gated AND NOT v_live THEN 'GATED' WHEN v_live AND NOT v_gated THEN 'LIVE (selected contractor opens at selection)' WHEN v_live AND v_gated THEN 'AMBIGUOUS (cannot tell the policies apart)' ELSE 'UNEXPECTED' END || E'\n';
  END LOOP;

  RAISE EXCEPTION E'gh2559 fee-gate proof (rolled back) db_now=%\n%', now(), out USING ERRCODE = 'P0U01';
END
$proof$;
