-- gh-2559 / PR #2578: production proof of the bidder view's free-text handling (template; build with
-- tools/gh2559-freetext-prod-proof-build.py). ONE DO block, ends in RAISE EXCEPTION, so nothing it does persists.
-- It runs the OLD view file, then the NEW view file, each created inside the block, and for each reads the same
-- plants as a contractor who is only bidding. Fixtures are looked up by what they are (no identifier hard-coded).
-- The report holds counts and plant labels only; no homeowner value is read into it.
DO $proof$
DECLARE
  v_files constant text[] := ARRAY[@OLD@, @NEW@];
  v_names constant text[] := ARRAY['OLD head 08db93cd', 'NEW head'];
  kR uuid; kRu uuid; cR uuid; ownR uuid; ph int; p record;
  out text := ''; got_n text; got_c text; got_z text; leak boolean; resid boolean; okc boolean;
  base_notes jsonb; view_notes jsonb; rows_n bigint; notes_n bigint; changed_n bigint; city_n bigint; zip_n bigint; real_n bigint;
  n_leak int; n_ok int; n_resid int; n_over int; n_diff int; t0 timestamptz; ms numeric; hostile text;
BEGIN
  SELECT ct.id, ct.user_id INTO kR, kRu FROM public.contractors ct
   WHERE ct.status = 'active' AND ct.is_test AND ct.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.user_id = ct.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.selected_contractor_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.contractor_id = ct.id)
   ORDER BY ct.id LIMIT 1;
  SELECT c.id, c.user_id INTO cR, ownR FROM public.claims c
   WHERE NOT c.is_test AND c.ready_for_bids AND c.status IN ('active', 'bidding', 'pending') AND c.selected_contractor_id IS NULL
     AND EXISTS (SELECT 1 FROM public.profiles pf WHERE pf.id = c.user_id)
   ORDER BY c.id LIMIT 1;
  IF kR IS NULL OR cR IS NULL THEN RAISE EXCEPTION 'FIXTURE MISSING kR=% cR=%', kR IS NOT NULL, cR IS NOT NULL; END IF;
  UPDATE public.contractors SET is_test = false WHERE id = kR;   -- rolled back: the real bidder
  SELECT count(*) INTO real_n FROM public.claims WHERE NOT is_test AND ready_for_bids AND status IN ('active','bidding','pending');
  out := out || 'FIXTURES: bidder contractor flipped to real in the block; plant claim = one open real claim (its text is overwritten inside the block only); open real claims in production = ' || real_n || E'\n';
  SELECT jsonb_object_agg(id, homeowner_notes) INTO base_notes FROM public.claims WHERE NOT is_test AND ready_for_bids AND status IN ('active','bidding','pending') AND selected_contractor_id IS NULL;

  FOR ph IN 1 .. 2 LOOP
    EXECUTE v_files[ph];
    out := out || E'\n=== REAL DATA, ' || v_names[ph] || E' ===\n';
    -- real-data sweep, before any plant: what the bidder reads of the real open claims
    PERFORM set_config('request.jwt.claims', json_build_object('sub', kRu, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', kRu::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*), count(v.homeowner_notes), count(v.location_city), count(v.location_zip),
           jsonb_object_agg(v.id, v.homeowner_notes)
      INTO rows_n, notes_n, city_n, zip_n, view_notes
      FROM public.bidder_claim_summary v WHERE v.selected_contractor_id IS NULL AND v.id IN (SELECT (jsonb_object_keys(base_notes))::uuid);
    RESET ROLE;
    SELECT count(*) INTO changed_n FROM jsonb_each_text(base_notes) b
      WHERE b.value IS NOT NULL AND (view_notes ->> b.key) IS DISTINCT FROM b.value;
    out := out || format('REAL DATA (open real claims, counts only): rows read by the bidder %s | notes shown %s | notes the view changed %s | city shown %s | zip shown %s', rows_n, notes_n, changed_n, city_n, zip_n) || E'\n';

    DROP VIEW public.bidder_claim_summary;
  END LOOP;

  -- the plants (the sweep above runs first for both files, before any row is changed)
  FOR ph IN 1 .. 2 LOOP
    EXECUTE v_files[ph];
    out := out || E'\n=== PLANTS, ' || v_names[ph] || E' ===\n';
    n_leak := 0; n_ok := 0; n_resid := 0; n_over := 0; n_diff := 0;
    FOR p IN SELECT * FROM (VALUES
    @PLANTS@
    ) AS t(kind, lab, owner_name, addr, pcity, pzip, txt, bad, e_city, e_zip, e_resid) LOOP
      UPDATE public.profiles SET full_name = p.owner_name WHERE id = ownR;
      UPDATE public.claims SET property_address = p.addr, property_city = p.pcity, property_zip = p.pzip, homeowner_name = NULL, claim_number = NULL,
             homeowner_notes = nullif(p.txt, ''), job_type = 'insurance_rcv', urgency_reason = nullif(p.txt, '') WHERE id = cR;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', kRu, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', kRu::text, true);
      SET LOCAL ROLE authenticated;
      SELECT v.homeowner_notes, v.location_city, v.location_zip INTO got_n, got_c, got_z FROM public.bidder_claim_summary v WHERE v.id = cR;
      RESET ROLE;
      resid := p.e_resid;
      IF p.kind = 'addr' THEN
        leak := (got_c IS NOT NULL AND got_c ~* 'larkspur|hollow|quixote|meridian|\mrd\M|\munit\M|\mapt\M|\mbox\M|\mlot\M|\d' AND NOT resid)
             OR (got_z IS NOT NULL AND got_z !~ '^\d{5}$') OR got_z IN ('44170','10001','12345','4417','44');
        okc := (got_c IS NOT DISTINCT FROM p.e_city) AND (got_z IS NOT DISTINCT FROM p.e_zip);
        IF leak THEN n_leak := n_leak + 1; out := out || 'LEAK   address  ' || p.lab || E'\n';
        ELSIF okc THEN n_ok := n_ok + 1; ELSE n_diff := n_diff + 1; out := out || 'DIFF   address  ' || p.lab || E' (not a leak; differs from the expected city/zip)\n'; END IF;
      ELSIF p.kind = 'note' THEN
        leak := EXISTS (SELECT 1 FROM unnest(p.bad) b WHERE got_n IS NOT NULL AND position(lower(b) IN lower(got_n)) > 0);
        IF leak AND resid THEN n_resid := n_resid + 1;
        ELSIF leak THEN n_leak := n_leak + 1; out := out || 'LEAK   notes    ' || p.lab || E'\n';
        ELSE n_ok := n_ok + 1; END IF;
      ELSE
        IF got_n IS DISTINCT FROM p.txt AND resid THEN n_resid := n_resid + 1;
        ELSIF got_n IS DISTINCT FROM p.txt THEN n_over := n_over + 1; out := out || 'OVER   benign   ' || p.lab || E' (changed)\n'; ELSE n_ok := n_ok + 1; END IF;
      END IF;
    END LOOP;
    out := out || format('PLANTS: ok %s | LEAK %s | stated residuals / stated costs %s | over-redaction %s | address differs-not-leak %s', n_ok, n_leak, n_resid, n_over, n_diff) || E'\n';

    -- cost: a hostile 2000-character note (digits, dots, capitals) through the view
    hostile := left(repeat('12.3 Ab Cd 4567 Ef-Gh 9 ', 120), 2000);
    UPDATE public.claims SET homeowner_notes = hostile WHERE id = cR;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', kRu, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    t0 := clock_timestamp();
    PERFORM v.homeowner_notes FROM public.bidder_claim_summary v WHERE v.id = cR;
    ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
    RESET ROLE;
    out := out || format('HOSTILE 2000-char note read through the view: %s ms', round(ms, 1)) || E'\n';
    DROP VIEW public.bidder_claim_summary;
  END LOOP;
  RAISE EXCEPTION E'\n%', out USING ERRCODE = 'P0U09';
END
$proof$;
