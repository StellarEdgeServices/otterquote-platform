-- gh-2559 claims-row half proof: the bidder-only view public.bidder_claim_summary and the narrowing of the two
-- contractor SELECT policies on public.claims (supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql (applied 2026-10-08, ledger version 20261008231303) and supabase/migrations_drafts/
-- gh2559_claims_policy_narrow.sql; NOT APPLIED when this was written). Decision D-368.
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement. It is a single DO block whose last action is
-- a deliberate RAISE EXCEPTION, so every fixture write and every DDL statement rolls back whatever the client
-- does. The findings are the exception text.
--   Run this file alone     : prints the matrix against whatever is live, and a VERDICT line (LIVE / UNEXPECTED).
--                             That is the NEGATIVE CONTROL: the same reads against production as it is today.
--   Forward-rollback mode   : replace the NULLs between the @V@, @N@, @NR@ and @VR@ markers with the body of
--                             the view migration, the narrowing migration, the narrowing rollback and the view
--                             rollback, each dollar-quoted (tags $v$, $n$, $nr$, $vr$) and with its BEGIN; and
--                             COMMIT; lines removed (scripts are built by the author; see the PR body). The
--                             block then prints the matrix five times: live, after view, after view + narrowing,
--                             after narrowing rollback, after view rollback.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each read.
-- NO IDENTIFIER IS HARD-CODED. Every fixture is looked up at run time by what it is:
--   kS, cS  active is_test contractor, owning no claim, whose quote on cS is 'selected' and to whom the claim
--           is selected (the selected contractor, as production has it today)
--   kQ, cQ  active is_test contractor owning no claim, selected nowhere, with a 'submitted' quote on cQ, an
--           open test claim not selected to anyone (the contractor who is merely BIDDING)
--   kT      another active is_test contractor, owning no claim, selected nowhere, no quote on cE or cQ
--           (eligible to bid, has not)
--   kR      another such contractor; the block sets is_test = false on it (rolled back): the real bidder
--   cE      open test claim with an estimate file, a parsed summary and a scope summary
--   cR      open real claim (not is_test)
--   cH, ownH  a claim whose owner has no contractor account, and that owner
--   kP      a contractor that is pending_approval; ownQ owner of cQ; admin email read from public.is_admin_email()
-- The FIXTURES lines print roles and flags, never ids. File contents and summary contents are never read:
-- reads are counts and null-tests.
--
-- Column legend. base = SELECT on public.claims (the table); view = SELECT on public.bidder_claim_summary.
--   -2 = the view does not exist yet; -3 = permission denied; any other number is a row count.
--   expected triple: live / after view / after view + narrowing.
-- Rows that matter most (D-368):
--   B1,B2,Q1,Q3,R1,R6   a bidder reads the BASE row of a claim it is only bidding on / eligible for:
--                         1 -> 1 -> 0   (this is the change)
--   B3,B6,B7,B8,Q2,Q5,R2  the same bidder through the VIEW:  -2 -> 1 -> 1
--   B4,R5               filenames through the view for a non-selected caller:  -2 -> 0 -> 0
--   S1..S4              the SELECTED contractor reads exactly as live: 1 -> 1 -> 1 (base), file names visible
--   O*, AD*, V*, A*     owner, admin, service_role, anon: unchanged
--   L5                  free text (CEO ruling 6045859470): phone, email and street line blanked for a bidder
--   L1..L4              location (review 6025641188 findings 1 and 2): no value the view hands a bidder is the
--                         stored address, a street line or a house number; L3 is the comma-less address case
--   PGOLD               the OLD page query (select * from claims, ready_for_bids filter): returns rows
--                         live, returns 0 after narrowing -- the reason the pages must ship first
--   PG*                 every bidder page query from the enumeration, run against the view
DO $proof$
DECLARE
  v_view text := /*@V@*/ NULL /*@V@*/;
  v_nar  text := /*@N@*/ NULL /*@N@*/;
  v_nrb  text := /*@NR@*/ NULL /*@NR@*/;
  v_vrb  text := /*@VR@*/ NULL /*@VR@*/;
  -- the exact column lists the pages select from the view (tests/gh2559-bidder-claims-view.mjs checks these
  -- strings are the ones in the page source)
  c_opp  constant text := 'id, status, ready_for_bids, created_at, trades, job_type, funding_type, damage_type, existing_shingle_brand, existing_shingle_color, rcv_amount, acv_amount, deductible_amount, roof_squares, repair_squares, measured_squares, measurement_shape, contractor_scope_summary, parsed_line_items, urgency, urgency_deadline, homeowner_notes, roofing_bid_released_at, gutters_bid_released_at, siding_bid_released_at, windows_bid_released_at, bid_window_expires_at, has_estimate, has_measurements, location_city, location_zip, estimate_filename, measurements_filename, selected_contractor_id';
  c_bid  constant text := 'id, trades, job_type, funding_type, damage_type, material_category, shingle_type, impact_class, designer_product, designer_manufacturer, rcv_amount, parsed_line_items, siding_bid_released_at, location_city, location_zip, carrier_profile_name, estimate_filename, measurements_filename, selected_contractor_id';
  c_dash constant text := 'id, trades, status';
  c_pend constant text := 'id, location_city, location_zip, damage_type';
  c_forbidden constant text[] := ARRAY['user_id','claim_number','homeowner_name','adjuster_id','adjuster_name','adjuster_email','adjuster_phone',
    'ingest_email','ingest_email_address','property_address','video_url','referral_code','referral_id','referral_source','referral_agent_id',
    'docusign_envelope_id','deductible_stripe_id','platform_fee_stripe_id','color_confirmation_envelope_id','project_confirmation_envelope_id',
    'utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','first_touch_landing_path','first_touch_referrer',
    'hover_order_id','itel_order_id','is_test','carrier_id','project_confirmation','hover_measurements'];
  kS uuid; kSu uuid; cS uuid;
  kQ uuid; kQu uuid; cQ uuid; ownQ uuid;
  kT uuid; kTu uuid; kR uuid; kRu uuid; kP uuid; kPu uuid;
  cE uuid; cR uuid; ownR uuid; cH uuid; ownH uuid;
  v_admin text;
  out text := '';
  phase text; phases text[]; pidx int; has_view boolean; narrowed boolean;
  r record; n bigint; t text;
  exp_n bigint; ok_all boolean; ok_live boolean; ok_view boolean; ok_both boolean;
  e_cur bigint;
  tot bigint; sv_f text;
  j jsonb; sv_a text; sv_c text; sv_z text;
BEGIN
  -- ---------------------------------------------------------------- fixture lookup (superuser)
  SELECT ct.id, ct.user_id, c.id INTO kS, kSu, cS
    FROM public.contractors ct
    JOIN public.claims c ON c.selected_contractor_id = ct.id
    JOIN public.quotes q ON q.claim_id = c.id AND q.contractor_id = ct.id AND q.status = 'selected'
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.user_id = ct.user_id)
   ORDER BY ct.id, c.id LIMIT 1;
  SELECT ct.id, ct.user_id, c.id, c.user_id INTO kQ, kQu, cQ, ownQ
    FROM public.quotes q
    JOIN public.contractors ct ON ct.id = q.contractor_id AND ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
    JOIN public.claims c ON c.id = q.claim_id AND c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending')
                        AND c.selected_contractor_id IS NULL
   WHERE q.status = 'submitted' AND ct.id <> kS
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims x WHERE x.selected_contractor_id = ct.id)
   ORDER BY ct.id, c.id LIMIT 1;
  SELECT c.id INTO cE FROM public.claims c
   WHERE c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.selected_contractor_id IS NULL
     AND c.estimate_filename IS NOT NULL AND c.parsed_line_items IS NOT NULL AND c.contractor_scope_summary IS NOT NULL
   ORDER BY c.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kT, kTu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL AND ct.id NOT IN (kS, kQ)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kR, kRu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL AND ct.id NOT IN (kS, kQ, kT)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT ct.id, ct.user_id INTO kP, kPu FROM public.contractors ct
   WHERE ct.status = 'pending_approval' AND ct.user_id IS NOT NULL ORDER BY ct.id LIMIT 1;
  SELECT c.id, c.user_id INTO cR, ownR FROM public.claims c
   WHERE NOT c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.selected_contractor_id IS NULL
   ORDER BY c.id LIMIT 1;
  SELECT c.id, c.user_id INTO cH, ownH FROM public.claims c
   WHERE NOT EXISTS (SELECT 1 FROM public.contractors x WHERE x.user_id = c.user_id)
   ORDER BY c.id LIMIT 1;
  v_admin := substring(pg_get_functiondef('public.is_admin_email()'::regprocedure) FROM '''([^'']+@[^'']+)''');

  IF kS IS NULL OR kQ IS NULL OR kT IS NULL OR kR IS NULL OR kP IS NULL OR cE IS NULL OR cR IS NULL OR cH IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'gh2559 view proof: FIXTURE MISSING kS=% kQ=% kT=% kR=% kP=% cE=% cR=% cH=% admin=%',
      kS IS NOT NULL, kQ IS NOT NULL, kT IS NOT NULL, kR IS NOT NULL, kP IS NOT NULL, cE IS NOT NULL, cR IS NOT NULL, cH IS NOT NULL,
      v_admin IS NOT NULL USING ERRCODE = 'P0U02';
  END IF;

  -- ---------------------------------------------------------------- fixture changes (rolled back)
  UPDATE public.contractors SET is_test = false WHERE id = kR;
  SELECT count(*) INTO tot FROM public.claims;

  out := out || 'FIXTURES contractors (role flags only): kS selected is_test=' || (SELECT is_test FROM public.contractors WHERE id = kS)
    || ' ; kQ bidding is_test=' || (SELECT is_test FROM public.contractors WHERE id = kQ)
    || ' ; kT eligible is_test=' || (SELECT is_test FROM public.contractors WHERE id = kT)
    || ' ; kR real is_test=' || (SELECT is_test FROM public.contractors WHERE id = kR) || ' (flipped in the block)'
    || ' ; kP status=' || (SELECT status FROM public.contractors WHERE id = kP) || E'\n';
  out := out || 'FIXTURES claims: ' || (
    SELECT string_agg(lbl || ' is_test=' || c.is_test || ' ' || c.status || ' rfb=' || c.ready_for_bids
           || ' selected=' || (c.selected_contractor_id IS NOT NULL)
           || ' est=' || (c.estimate_filename IS NOT NULL) || ' meas=' || (c.measurements_filename IS NOT NULL)
           || ' summary=' || (c.parsed_line_items IS NOT NULL AND c.contractor_scope_summary IS NOT NULL), ' ; ' ORDER BY lbl)
    FROM (VALUES ('cE', cE), ('cQ', cQ), ('cR', cR), ('cS', cS), ('cH', cH)) v(lbl, cid)
    JOIN public.claims c ON c.id = v.cid) || E'\n';

  phases := CASE WHEN v_view IS NULL THEN ARRAY['live']
                 ELSE ARRAY['live', 'after view', 'after view + narrowing', 'after narrowing rollback', 'after view rollback'] END;
  ok_live := true; ok_view := true; ok_both := true;

  FOR pidx IN 1 .. array_length(phases, 1) LOOP
    phase := phases[pidx];
    IF phase = 'after view' THEN EXECUTE v_view; END IF;
    IF phase = 'after view + narrowing' THEN EXECUTE v_nar; END IF;
    IF phase = 'after narrowing rollback' THEN EXECUTE v_nrb; END IF;
    IF phase = 'after view rollback' THEN EXECUTE v_vrb; END IF;
    has_view  := to_regclass('public.bidder_claim_summary') IS NOT NULL;
    narrowed  := EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims'
                          AND policyname = 'Contractors can view claims they are selected on');

    out := out || E'\n== ' || phase || E' ==\n';
    SELECT 'CLAIMS policies: n=' || count(*) || ' md5=' || left(md5(string_agg(policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)), 8)
           || '  contractor SELECT policies: ' || coalesce(string_agg(policyname, ' ; ' ORDER BY policyname) FILTER (WHERE cmd = 'SELECT' AND policyname ILIKE 'Contractors%'), 'none')
      INTO t FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims';
    out := out || t || E'\n';
    out := out || 'VIEW exists=' || has_view;
    IF has_view THEN
      out := out || ' security_barrier=' || coalesce((SELECT 'security_barrier=true' = ANY (reloptions) FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass), false)
        || ' columns=' || (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.bidder_claim_summary'::regclass AND attnum > 0 AND NOT attisdropped)
        || ' forbidden_columns_present=' || (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.bidder_claim_summary'::regclass AND attnum > 0 AND NOT attisdropped AND attname = ANY (c_forbidden))
        || ' acl=' || (SELECT relacl::text FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass);
    END IF;
    out := out || E'\n';
    SELECT 'TRIGGERS on public.claims: n=' || count(*) || ' md5=' || left(md5(string_agg(pg_get_triggerdef(oid), E'\n' ORDER BY tgname)), 8)
      INTO t FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND NOT tgisinternal;
    out := out || t || E'\n';

    FOR r IN
      SELECT * FROM (VALUES
        ( 1, 'B1 bidder kT (eligible, no bid) -> BASE row of open test claim cE',               'authenticated', kTu, NULL::text, 'base',    cE, kT, NULL::text,  1::bigint, 1::bigint, 0::bigint),
        ( 2, 'B2 bidder kT -> BASE row cE, identity columns (homeowner_name, claim_number, adjuster_*, estimate_filename)', 'authenticated', kTu, NULL, 'basecols', cE, kT, NULL, 1, 1, 0),
        ( 3, 'B3 bidder kT -> VIEW row cE',                                                      'authenticated', kTu, NULL, 'view',    cE, kT, NULL, -2, 1, 1),
        ( 4, 'B4 bidder kT -> VIEW cE, raw file names non-null (must be 0 before selection)',    'authenticated', kTu, NULL, 'viewraw', cE, kT, NULL, -2, 0, 0),
        ( 5, 'B5 bidder kT -> VIEW cE, estimate-present flag true (opportunity card badge)',     'authenticated', kTu, NULL, 'viewhas', cE, kT, NULL, -2, 1, 1),
        ( 6, 'B6 bidder kT -> VIEW cE, parsed summary and scope summary present',                'authenticated', kTu, NULL, 'viewsum', cE, kT, NULL, -2, 1, 1),
        ( 7, 'B7 bidder kT -> VIEW cE, city and zip present (location shown instead of street)', 'authenticated', kTu, NULL, 'viewloc', cE, kT, NULL, -2, 1, 1),
        ( 8, 'B8 test bidder kT -> real claim cR, BASE (live policy lets a test contractor read real claims)', 'authenticated', kTu, NULL, 'base', cR, kT, NULL, 1, 1, 0),
        ( 9, 'B9 test bidder kT -> real claim cR, VIEW (world match: refused)',                  'authenticated', kTu, NULL, 'view',    cR, kT, NULL, -2, 0, 0),
        (10, 'R1 real bidder kR -> real open claim cR, BASE',                                   'authenticated', kRu, NULL, 'base',    cR, kR, NULL, 1, 1, 0),
        (11, 'R2 real bidder kR -> real open claim cR, VIEW',                                   'authenticated', kRu, NULL, 'view',    cR, kR, NULL, -2, 1, 1),
        (12, 'R3 real bidder kR -> test claim cE, VIEW (world match)',                          'authenticated', kRu, NULL, 'view',    cE, kR, NULL, -2, 0, 0),
        (13, 'R4 real bidder kR -> test claim cE, BASE (world fence on the live policy)',       'authenticated', kRu, NULL, 'base',    cE, kR, NULL, 0, 0, 0),
        (14, 'R5 real bidder kR -> VIEW cR, raw file names non-null',                           'authenticated', kRu, NULL, 'viewraw', cR, kR, NULL, -2, 0, 0),
        (15, 'R6 real bidder kR -> BASE cR, identity columns',                                  'authenticated', kRu, NULL, 'basecols', cR, kR, NULL, 1, 1, 0),
        (16, 'Q1 bidding contractor kQ (has a bid) -> BASE row of cQ, open',                    'authenticated', kQu, NULL, 'base',    cQ, kQ, NULL, 1, 1, 0),
        (17, 'Q2 kQ -> VIEW row cQ, open',                                                      'authenticated', kQu, NULL, 'view',    cQ, kQ, NULL, -2, 1, 1),
        (18, 'Q3 kQ -> BASE cQ, identity columns',                                              'authenticated', kQu, NULL, 'basecols', cQ, kQ, NULL, 1, 1, 0),
        (19, 'Q4 kQ -> BASE cQ after the claim closed for bids (the quotes policy)',            'authenticated', kQu, NULL, 'base',    cQ, kQ, 'close', 1, 1, 0),
        (20, 'Q5 kQ -> VIEW cQ after the claim closed for bids (own bid keeps its summary)',    'authenticated', kQu, NULL, 'view',    cQ, kQ, 'close', -2, 1, 1),
        (21, 'Q6 kQ -> page query: its quotes joined to the BASE claim (dashboard embed)',      'authenticated', kQu, NULL, 'embed',   NULL::uuid, kQ, NULL, -1, -1, -1),
        (22, 'Q7 kQ -> page query: pending-bid lookup through the VIEW by its quote claim ids', 'authenticated', kQu, NULL, 'viewq',   NULL, kQ, NULL, -2, -1, -1),
        (23, 'S1 selected contractor kS -> BASE row cS',                                        'authenticated', kSu, NULL, 'base',    cS, kS, NULL, 1, 1, 1),
        (24, 'S2 kS -> BASE cS, identity columns (read exactly as live)',                       'authenticated', kSu, NULL, 'basecols', cS, kS, NULL, 1, 1, 1),
        (25, 'S3 kS -> VIEW cS',                                                                'authenticated', kSu, NULL, 'view',    cS, kS, NULL, -2, 1, 1),
        (26, 'S4 kS -> VIEW cS, raw file names non-null (1 only if the claim has one)',         'authenticated', kSu, NULL, 'viewraw', cS, kS, NULL, -2, -1, -1),
        (54, 'S6 kS -> VIEW cS with a file name on the claim (positive control: the selected contractor DOES get the path)', 'authenticated', kSu, NULL, 'viewraw', cS, kS, 'file', -2, 1, 1),
        (55, 'S7 kQ -> VIEW cE with a file name on the claim (negative control: a bidder who is not selected gets null)', 'authenticated', kQu, NULL, 'viewraw', cE, kQ, NULL, -2, 0, 0),
        (27, 'S5 kS -> page query: its quotes joined to the BASE claim (dashboard embed)',      'authenticated', kSu, NULL, 'embed',   NULL, kS, NULL, -1, -1, -1),
        (28, 'O1 homeowner (no contractor account) -> BASE own claim cH',                       'authenticated', ownH, NULL, 'base',   cH, NULL, NULL, 1, 1, 1),
        (29, 'O2 the same homeowner -> VIEW own claim cH (the view answers by contractor identity: none)', 'authenticated', ownH, NULL, 'view',   cH, NULL, NULL, -2, 0, 0),
        (30, 'O3 owner of cR -> BASE cQ (another homeowner)',                                   'authenticated', ownR, NULL, 'base',   cQ, NULL, NULL, 0, 0, 0),
        (31, 'AD1 admin-email session -> BASE cE',                                              'authenticated', '00000000-0000-4000-8000-000000002559'::uuid, v_admin, 'base', cE, NULL, NULL, 1, 1, 1),
        (32, 'P1 pending_approval contractor kP -> BASE cE',                                    'authenticated', kPu, NULL, 'base',    cE, kP, NULL, 0, 0, 0),
        (33, 'P2 pending_approval contractor kP -> VIEW cE',                                    'authenticated', kPu, NULL, 'view',    cE, kP, NULL, -2, 0, 0),
        (34, 'V1 service_role -> BASE, all claims',                                             'service_role', NULL, NULL, 'baseall',  NULL, NULL, NULL, -5, -5, -5),
        (35, 'V2 service_role -> VIEW, all rows (no contractor identity, so none)',             'service_role', NULL, NULL, 'viewall',  NULL, NULL, NULL, -2, 0, 0),
        (36, 'A1 anon -> BASE cE',                                                              'anon', NULL, NULL, 'base',    cE, NULL, NULL, 0, 0, 0),
        (37, 'A2 anon -> VIEW cE',                                                              'anon', NULL, NULL, 'view',    cE, NULL, NULL, -2, -3, -3),
        (38, 'T-all kT -> BASE, every claim it can read (oracle)',                              'authenticated', kTu, NULL, 'baseall', NULL, kT, NULL, -1, -1, -1),
        (39, 'T-view kT -> VIEW, every row it can read (oracle)',                               'authenticated', kTu, NULL, 'viewall', NULL, kT, NULL, -2, -1, -1),
        (40, 'R-all kR -> BASE (oracle)',                                                       'authenticated', kRu, NULL, 'baseall', NULL, kR, NULL, -1, -1, -1),
        (41, 'R-view kR -> VIEW (oracle)',                                                      'authenticated', kRu, NULL, 'viewall', NULL, kR, NULL, -2, -1, -1),
        (42, 'Q-all kQ -> BASE (oracle)',                                                       'authenticated', kQu, NULL, 'baseall', NULL, kQ, NULL, -1, -1, -1),
        (43, 'Q-view kQ -> VIEW (oracle)',                                                      'authenticated', kQu, NULL, 'viewall', NULL, kQ, NULL, -2, -1, -1),
        (44, 'S-all kS -> BASE (oracle)',                                                       'authenticated', kSu, NULL, 'baseall', NULL, kS, NULL, -1, -1, -1),
        (45, 'S-view kS -> VIEW (oracle)',                                                      'authenticated', kSu, NULL, 'viewall', NULL, kS, NULL, -2, -1, -1),
        (46, 'PGOLD kT -> the OLD opportunities page query (select * from claims, ready_for_bids, status filter, limit 50)', 'authenticated', kTu, NULL, 'pageold', NULL, kT, NULL, -1, -1, 0),
        (47, 'PG1 kT -> opportunities page query against the VIEW (explicit column list, same filter, limit 50)', 'authenticated', kTu, NULL, 'pageopp', NULL, kT, NULL, -2, -1, -1),
        (48, 'PG2 kR -> opportunities page query against the VIEW (real world)',                'authenticated', kRu, NULL, 'pageopp', NULL, kR, NULL, -2, -1, -1),
        (49, 'PG3 kQ -> bid form query against the VIEW for its claim cQ (explicit column list)', 'authenticated', kQu, NULL, 'pagebid', cQ, kQ, NULL, -2, 1, 1),
        (50, 'PG4 kT -> bid form query against the VIEW for claim cE',                           'authenticated', kTu, NULL, 'pagebid', cE, kT, NULL, -2, 1, 1),
        (51, 'PG5 kS -> bid form query against the VIEW for its selected claim cS',              'authenticated', kSu, NULL, 'pagebid', cS, kS, NULL, -2, 1, 1),
        (52, 'PG6 kT -> dashboard availability query against the VIEW (id, trades, status ...)', 'authenticated', kTu, NULL, 'pagedash', NULL, kT, NULL, -2, -1, -1),
        (53, 'PG7 kQ -> dashboard pending-bid lookup (id, city, zip, damage_type) for its quote claims', 'authenticated', kQu, NULL, 'pagepend', NULL, kQ, NULL, -2, -1, -1),
        (54, 'L1 real bidder kR -> every row of the VIEW: rows whose city is the stored address, starts with a digit or holds the street line, or whose zip is the house number (must be 0)', 'authenticated', kRu, NULL, 'viewleak', NULL, kR, NULL, -2, 0, 0),
        (55, 'L2 test bidder kT -> every row of the VIEW: the same count (must be 0)',            'authenticated', kTu, NULL, 'viewleak', NULL, kT, NULL, -2, 0, 0),
        (56, 'L3 real bidder kR -> VIEW cR with its address set to a street line with NO comma and a five-digit house number, no city or zip column: city and zip both null (1 = nothing of the street came through)', 'authenticated', kRu, NULL, 'viewnoaddr', cR, kR, 'nocomma', -2, 1, 1),
        (57, 'L4 real bidder kR -> VIEW cR with the address "street, city, ST zip": city and zip both present (control for L3)', 'authenticated', kRu, NULL, 'viewloc', cR, kR, 'commas', -2, 1, 1),
        (58, 'L5 real bidder kR -> VIEW cR with a phone number, an email address and a street line typed into the notes: they come back with none of the three (1 = redacted)', 'authenticated', kRu, NULL, 'viewnotes', cR, kR, 'notes', -2, 1, 1)
      ) AS s(ord, label, role, sub, email, kind, target, ct, mut, e_live, e_view, e_both) ORDER BY ord
    LOOP
      e_cur := CASE WHEN phase IN ('live', 'after view rollback') THEN r.e_live
                    WHEN phase IN ('after view', 'after narrowing rollback') THEN r.e_view ELSE r.e_both END;

      -- oracle values (superuser, before the role switch) for rows whose expected count is computed
      IF e_cur IN (-1, -5) THEN
        IF r.kind = 'baseall' AND e_cur = -5 THEN
          exp_n := tot;
        ELSIF r.kind = 'baseall' THEN
          IF narrowed THEN
            SELECT count(*) INTO exp_n FROM public.claims c WHERE c.selected_contractor_id = r.ct;
          ELSE
            SELECT count(*) INTO exp_n FROM public.claims c JOIN public.contractors ct ON ct.id = r.ct
             WHERE (c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND ct.status = 'active'
                    AND (NOT c.is_test OR (c.is_test AND ct.is_test)))
                OR c.id IN (SELECT q.claim_id FROM public.quotes q WHERE q.contractor_id = r.ct);
          END IF;
        ELSIF r.kind = 'viewall' THEN
          SELECT count(*) INTO exp_n FROM public.claims c JOIN public.contractors ct ON ct.id = r.ct
           WHERE (ct.status = 'active' AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.is_test = ct.is_test)
              OR c.selected_contractor_id = ct.id
              OR c.id IN (SELECT q.claim_id FROM public.quotes q WHERE q.contractor_id = ct.id);
        ELSIF r.kind = 'embed' THEN
          IF narrowed THEN
            SELECT count(*) INTO exp_n FROM public.quotes q JOIN public.claims c ON c.id = q.claim_id WHERE q.contractor_id = r.ct AND c.selected_contractor_id = r.ct;
          ELSE
            SELECT count(*) INTO exp_n FROM public.quotes q JOIN public.claims c ON c.id = q.claim_id WHERE q.contractor_id = r.ct;
          END IF;
        ELSIF r.kind IN ('viewq', 'pagepend') THEN
          SELECT count(*) INTO exp_n FROM public.quotes q WHERE q.contractor_id = r.ct;
        ELSIF r.kind IN ('pageopp', 'pagedash') THEN
          SELECT least(50, count(*)) INTO exp_n FROM public.claims c JOIN public.contractors ct ON ct.id = r.ct
           WHERE ct.status = 'active' AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.is_test = ct.is_test;
        ELSIF r.kind = 'pageold' THEN
          IF narrowed THEN exp_n := 0;
          ELSE
            SELECT least(50, count(*)) INTO exp_n FROM public.claims c JOIN public.contractors ct ON ct.id = r.ct
             WHERE ct.status = 'active' AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending')
               AND (NOT c.is_test OR (c.is_test AND ct.is_test));
          END IF;
        ELSIF r.kind = 'viewraw' THEN
          SELECT count(*) INTO exp_n FROM public.claims c WHERE c.id = r.target AND c.selected_contractor_id = r.ct
             AND (c.estimate_filename IS NOT NULL OR c.measurements_filename IS NOT NULL);
        END IF;
      ELSE
        exp_n := e_cur;
      END IF;
      -- kinds that read the view answer -2 while it does not exist
      IF r.kind IN ('view', 'viewraw', 'viewhas', 'viewsum', 'viewloc', 'viewleak', 'viewnoaddr', 'viewnotes', 'viewall', 'viewq', 'pageopp', 'pagebid', 'pagedash', 'pagepend') AND NOT has_view THEN
        exp_n := -2;
      END IF;

      IF r.mut = 'close' THEN UPDATE public.claims SET ready_for_bids = false WHERE id = cQ; END IF;
      IF r.mut = 'file' THEN SELECT estimate_filename INTO sv_f FROM public.claims WHERE id = cS; UPDATE public.claims SET estimate_filename = 'proof-fixture/est.pdf' WHERE id = cS; END IF;
      IF r.mut = 'notes' THEN
        SELECT homeowner_notes, urgency_reason, job_type INTO sv_a, sv_c, sv_z FROM public.claims WHERE id = cR;
        UPDATE public.claims SET homeowner_notes = E'Steep back slope.\nCall 317-555-0142 or proof@example.invalid\nWe are at 999 Proofstreet Rd',
               urgency_reason = 'call (317) 555-0142', job_type = 'insurance_rcv' WHERE id = cR;
      END IF;
      IF r.mut IN ('nocomma', 'commas') THEN
        SELECT property_address, property_city, property_zip INTO sv_a, sv_c, sv_z FROM public.claims WHERE id = cR;
        UPDATE public.claims SET property_city = NULL, property_zip = NULL,
               property_address = CASE WHEN r.mut = 'nocomma' THEN '12345 Proofstreet Rd' ELSE '12345 Proofstreet Rd, Proofville, IN 46000' END
         WHERE id = cR;
      END IF;

      PERFORM set_config('request.jwt.claims',
        CASE WHEN r.sub IS NULL THEN json_build_object('role', r.role)::text
             ELSE json_build_object('sub', r.sub, 'role', r.role, 'email', coalesce(r.email, 'gh2559-proof@example.invalid'))::text END, true);
      PERFORM set_config('role', r.role, true);
      BEGIN
        IF r.kind = 'base' THEN
          EXECUTE 'SELECT count(*) FROM public.claims WHERE id = $1' INTO n USING r.target;
        ELSIF r.kind = 'basecols' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT homeowner_name, claim_number, adjuster_name, adjuster_email, adjuster_phone, estimate_filename FROM public.claims WHERE id = $1) q' INTO n USING r.target;
        ELSIF r.kind = 'baseall' THEN
          EXECUTE 'SELECT count(*) FROM public.claims' INTO n;
        ELSIF r.kind = 'view' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1' INTO n USING r.target;
        ELSIF r.kind = 'viewall' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary' INTO n;
        ELSIF r.kind = 'viewraw' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND (estimate_filename IS NOT NULL OR measurements_filename IS NOT NULL)' INTO n USING r.target;
        ELSIF r.kind = 'viewhas' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND has_estimate' INTO n USING r.target;
        ELSIF r.kind = 'viewsum' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND parsed_line_items IS NOT NULL AND contractor_scope_summary IS NOT NULL' INTO n USING r.target;
        ELSIF r.kind = 'viewloc' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND location_city IS NOT NULL AND location_zip IS NOT NULL' INTO n USING r.target;
        ELSIF r.kind = 'viewnoaddr' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND location_city IS NULL AND location_zip IS NULL' INTO n USING r.target;
        ELSIF r.kind = 'viewnotes' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id = $1 AND homeowner_notes LIKE ''Steep back slope.%'' AND homeowner_notes !~ ''555|@|Proofstreet''' INTO n USING r.target;
        ELSIF r.kind = 'viewleak' THEN
          -- read what the bidder is given, as the bidder; it is compared with the base row after the role is reset
          EXECUTE 'SELECT coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''c'', location_city, ''z'', location_zip)), ''[]''::jsonb) FROM public.bidder_claim_summary' INTO j;
        ELSIF r.kind = 'embed' THEN
          EXECUTE 'SELECT count(*) FROM public.quotes q JOIN public.claims c ON c.id = q.claim_id WHERE q.contractor_id = $1' INTO n USING r.ct;
        ELSIF r.kind = 'viewq' THEN
          EXECUTE 'SELECT count(*) FROM public.bidder_claim_summary WHERE id IN (SELECT claim_id FROM public.quotes WHERE contractor_id = $1)' INTO n USING r.ct;
        ELSIF r.kind = 'pageold' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT * FROM public.claims WHERE ready_for_bids = true AND status IN (''active'', ''bidding'', ''pending'') ORDER BY created_at DESC LIMIT 50) q' INTO n;
        ELSIF r.kind = 'pageopp' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT ' || c_opp || ' FROM public.bidder_claim_summary WHERE ready_for_bids = true AND status IN (''active'', ''bidding'', ''pending'') ORDER BY created_at DESC LIMIT 50) q' INTO n;
        ELSIF r.kind = 'pagebid' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT ' || c_bid || ' FROM public.bidder_claim_summary WHERE id = $1) q' INTO n USING r.target;
        ELSIF r.kind = 'pagedash' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT ' || c_dash || ' FROM public.bidder_claim_summary WHERE ready_for_bids = true AND status IN (''active'', ''bidding'', ''pending'') ORDER BY created_at DESC LIMIT 50) q' INTO n;
        ELSIF r.kind = 'pagepend' THEN
          EXECUTE 'SELECT count(*) FROM (SELECT ' || c_pend || ' FROM public.bidder_claim_summary WHERE id IN (SELECT claim_id FROM public.quotes WHERE contractor_id = $1)) q' INTO n USING r.ct;
        END IF;
        EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
        IF r.kind = 'viewleak' THEN
          -- superuser again: compare each value handed out with the stored address (nothing is printed)
          SELECT count(*) INTO n
            FROM jsonb_array_elements(j) e JOIN public.claims c ON c.id = (e ->> 'id')::uuid
           WHERE ((e ->> 'c') IS NOT NULL AND (
                      btrim(e ->> 'c') = btrim(c.property_address)
                   OR (e ->> 'c') ~ '^\s*\d'
                   OR (length(btrim(split_part(c.property_address, ',', 1))) >= 5
                       AND position(lower(btrim(split_part(c.property_address, ',', 1))) IN lower(e ->> 'c')) > 0)))
              OR ((e ->> 'z') IS NOT NULL AND c.property_address ~ '^\s*\d{5}'
                  AND (e ->> 'z') = substring(c.property_address FROM '^\s*(\d{5})')
                  AND c.property_address !~ '\D\d{5}(-\d{4})?\s*$');
        END IF;
      EXCEPTION
        WHEN undefined_table THEN
          EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); n := -2;
        WHEN insufficient_privilege THEN
          EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); n := -3;
        WHEN OTHERS THEN
          EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
          out := out || r.label || ' : ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 100) || E'\n'; n := -9;
      END;
      IF r.mut = 'close' THEN UPDATE public.claims SET ready_for_bids = true WHERE id = cQ; END IF;
      IF r.mut = 'file' THEN UPDATE public.claims SET estimate_filename = sv_f WHERE id = cS; END IF;
      IF r.mut = 'notes' THEN UPDATE public.claims SET homeowner_notes = sv_a, urgency_reason = sv_c, job_type = sv_z WHERE id = cR; END IF;
      IF r.mut IN ('nocomma', 'commas') THEN UPDATE public.claims SET property_address = sv_a, property_city = sv_c, property_zip = sv_z WHERE id = cR; END IF;

      out := out || r.label || ' : ' || n || '  (expected ' || exp_n || ')' || CASE WHEN n = exp_n THEN '' ELSE '   <-- MISMATCH' END || E'\n';
      IF n <> exp_n THEN
        IF phase IN ('live', 'after view rollback') THEN ok_live := false;
        ELSIF phase IN ('after view', 'after narrowing rollback') THEN ok_view := false;
        ELSE ok_both := false; END IF;
      END IF;
    END LOOP;
  END LOOP;

  out := out || E'\nVERDICT live matrix=' || CASE WHEN ok_live THEN 'AS EXPECTED' ELSE 'UNEXPECTED' END;
  IF v_view IS NOT NULL THEN
    out := out || ' ; after view=' || CASE WHEN ok_view THEN 'AS EXPECTED' ELSE 'UNEXPECTED' END
      || ' ; after view + narrowing=' || CASE WHEN ok_both THEN 'AS EXPECTED' ELSE 'UNEXPECTED' END
      || ' (the live and rollback phases share one expectation column, the after-view and narrowing-rollback phases another)';
  END IF;
  out := out || E'\n';
  RAISE EXCEPTION E'gh2559 bidder view proof (rolled back) db_now=%\n%', now(), out USING ERRCODE = 'P0U01';
END
$proof$;
