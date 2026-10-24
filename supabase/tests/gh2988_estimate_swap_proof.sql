-- gh-2988 proof: swapping the estimate file on an already-open claim clears the old parse (the HOLD), proven with a negative control.
-- Context: PR #2929 / gh-2559 left "an unparsed estimate swapped onto an already-open claim" as a named residual (Ben, 6281179334).
-- The live trigger public.claims_estimate_parse_state_guard (claims_guard_a0_parse_state) already nulls loss_sheet_parsed_at, parsed_line_items,
-- contractor_scope_summary and loss_sheet_parse_status when estimate_filename changes. This script proves it; it changes no schema.
--
-- RUN ON A RESTORED COPY OF PRODUCTION ONLY. NEVER RUN ON yeszghaspzwwstvsrioa. It was NOT run when written (read-only access).
-- It needs a role that may SET session_replication_role and ALTER TABLE public.claims (the owner / a superuser), exactly like the gh-2559 proof.
--
-- Safety, in this order:
--   1. Edit the one line `c_confirm constant text := 'NO';` below to 'YES-THIS-IS-A-RESTORED-COPY'. Unedited, the script refuses to do anything.
--   2. It refuses unless the claims_estimate_parse_state_guard trigger exists (this proves the live guard, so it must be present).
--   3. It touches only ONE row: the newest claim with is_test = true whose owner profile is_test = true (same fixture rule as the gh-2559 proof);
--      with no such row it refuses rather than use a real claim.
--   4. One transaction that ends in ROLLBACK. Every fixture write and the negative-control ALTER TABLE ... DISABLE TRIGGER roll back with it.
--      Do not paste a COMMIT after it, and do not run it through a client that auto-commits per statement.
--
-- Cases (each starts from the same fixture: ready_for_bids = true, estimate_filename = old file, all four parse columns populated):
--   C1 NEGATIVE CONTROL A  UPDATE that sets estimate_filename to its own value (the guard trigger fires, the filename does not change): summary intact.
--   C2 NEGATIVE CONTROL B  UPDATE of an unrelated column: summary intact.
--   S1 SWAP                UPDATE estimate_filename to a new file: all four columns become NULL.
--   S2 SWAP as the owner   same swap as role `authenticated` with the owner's JWT sub (the real homeowner path). If RLS refuses the write the
--                          case reports INFO, not FAIL: that is a different guard, not this one.
--   S3 CLOSES-ON QUERY     after S1, the closes-on selection returns the swapped claim (it is on hold: unparsed) and the bidder_claim_summary view,
--                          if it shows the claim at all, shows no old summary.
--   N1 NEGATIVE CONTROL C  with claims_guard_a0_parse_state DISABLED, the same swap leaves the OLD summary readable (stale). This proves the
--                          assertions above can fail: they would fail if the guard were missing.
--
-- Output: the final SELECT lists one row per check (check_id, result PASS/FAIL/INFO, detail) and a last row `OVERALL`. A RAISE NOTICE
-- repeats each line for clients that show notices. Paste the whole result set on issue #2988 to close it.

BEGIN;

CREATE TEMP TABLE gh2988_results (n serial, check_id text, result text, detail text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.gh2988_log(p_id text, p_ok boolean, p_detail text, p_info boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE r text := CASE WHEN p_info THEN 'INFO' WHEN p_ok THEN 'PASS' ELSE 'FAIL' END;
BEGIN
  INSERT INTO gh2988_results (check_id, result, detail) VALUES (p_id, r, p_detail);
  RAISE NOTICE 'gh2988 % %: %', r, p_id, p_detail;
END $f$;

-- Runs one statement as a role with the owner's JWT sub; returns 'ACCEPTED' (1 row) or 'REJECTED <sqlstate> <message>'.
CREATE FUNCTION pg_temp.gh2988_try_as(p_sub uuid, p_sql text, p_role text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2988-proof@example.invalid')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN CASE WHEN n = 1 THEN 'ACCEPTED' ELSE 'rows=' || n END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $f$;

DO $proof$
DECLARE
  c_confirm constant text := 'NO';   -- EDIT to 'YES-THIS-IS-A-RESTORED-COPY' on the restored copy, nowhere else
  OLD_FILE  constant text := 'gh2988/old-estimate.pdf';
  NEW_FILE  constant text := 'gh2988/new-estimate.pdf';
  good      constant jsonb := '{"sections":[{"name":"Roof","items":[{"desc":"Remove shingles","qty":31.5}]}],"summary":{"rcv":12345.67}}';
  c uuid; owner_id uuid;
  rec public.claims%ROWTYPE;
  res text; ok boolean; cnt int; seen_parsed jsonb; seen_scope text; vrow boolean;
BEGIN
  IF c_confirm <> 'YES-THIS-IS-A-RESTORED-COPY' THEN
    RAISE EXCEPTION 'gh2988 proof: refusing to run. Edit c_confirm to YES-THIS-IS-A-RESTORED-COPY, and only on a restored copy, never on production';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_a0_parse_state' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'gh2988 proof: trigger claims_guard_a0_parse_state is missing on public.claims; there is nothing to prove (or this is the wrong database)';
  END IF;

  SELECT cl.id, cl.user_id INTO c, owner_id
    FROM public.claims cl JOIN public.profiles p ON p.id = cl.user_id
   WHERE cl.is_test IS TRUE AND p.is_test IS TRUE
   ORDER BY cl.created_at DESC LIMIT 1;
  IF c IS NULL THEN RAISE EXCEPTION 'gh2988 proof: no is_test claim with an is_test owner; refusing to run on a real row'; END IF;

  -- ---------- C1 negative control A: filename "updated" to its own value ----------
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.claims SET ready_for_bids = true, estimate_filename = OLD_FILE, has_estimate = true,
         parsed_line_items = good, loss_sheet_parsed_at = now(), contractor_scope_summary = 'gh2988 scope summary',
         loss_sheet_parse_status = 'parsed'
   WHERE id = c;
  PERFORM set_config('session_replication_role', 'origin', true);

  UPDATE public.claims SET estimate_filename = estimate_filename WHERE id = c;
  SELECT * INTO rec FROM public.claims WHERE id = c;
  ok := rec.estimate_filename = OLD_FILE AND rec.loss_sheet_parsed_at IS NOT NULL AND rec.parsed_line_items IS NOT DISTINCT FROM good
        AND rec.contractor_scope_summary = 'gh2988 scope summary' AND rec.loss_sheet_parse_status = 'parsed';
  PERFORM pg_temp.gh2988_log('C1 control: same-value filename update leaves the summary intact', ok,
    format('file=%s parsed_at_set=%s items_kept=%s scope_kept=%s status=%s', rec.estimate_filename, rec.loss_sheet_parsed_at IS NOT NULL,
           rec.parsed_line_items IS NOT DISTINCT FROM good, rec.contractor_scope_summary IS NOT NULL, rec.loss_sheet_parse_status));

  -- ---------- C2 negative control B: unrelated column ----------
  UPDATE public.claims SET status = status WHERE id = c;
  SELECT * INTO rec FROM public.claims WHERE id = c;
  ok := rec.loss_sheet_parsed_at IS NOT NULL AND rec.parsed_line_items IS NOT DISTINCT FROM good
        AND rec.contractor_scope_summary IS NOT NULL AND rec.loss_sheet_parse_status = 'parsed';
  PERFORM pg_temp.gh2988_log('C2 control: unrelated-column update leaves the summary intact', ok,
    format('parsed_at_set=%s items_kept=%s scope_kept=%s status=%s', rec.loss_sheet_parsed_at IS NOT NULL,
           rec.parsed_line_items IS NOT DISTINCT FROM good, rec.contractor_scope_summary IS NOT NULL, rec.loss_sheet_parse_status));

  -- ---------- S1 swap (superuser/owner session; the guard is a trigger so the caller does not matter here) ----------
  UPDATE public.claims SET estimate_filename = NEW_FILE WHERE id = c;
  SELECT * INTO rec FROM public.claims WHERE id = c;
  ok := rec.estimate_filename = NEW_FILE AND rec.ready_for_bids IS TRUE
        AND rec.loss_sheet_parsed_at IS NULL AND rec.parsed_line_items IS NULL
        AND rec.contractor_scope_summary IS NULL AND rec.loss_sheet_parse_status IS NULL;
  PERFORM pg_temp.gh2988_log('S1 swap: new estimate_filename on an open claim nulls all four parse columns', ok,
    format('file=%s ready_for_bids=%s parsed_at=%s items=%s scope=%s status=%s', rec.estimate_filename, rec.ready_for_bids,
           rec.loss_sheet_parsed_at, rec.parsed_line_items IS NOT NULL, rec.contractor_scope_summary IS NOT NULL, rec.loss_sheet_parse_status));

  -- ---------- S3 closes-on selection + bidder view, evaluated on the swapped state ----------
  SELECT count(*) INTO cnt FROM public.claims
   WHERE id = c AND ready_for_bids AND (estimate_filename IS NOT NULL OR has_estimate) AND loss_sheet_parsed_at IS NULL;
  PERFORM pg_temp.gh2988_log('S3a closes-on selection returns the swapped claim while it awaits the re-parse (by design; the hold)', cnt = 1,
    format('rows=%s (expect 1: unparsed and held until parse-loss-sheet rewrites the summary)', cnt));
  BEGIN
    EXECUTE 'SELECT parsed_line_items, contractor_scope_summary FROM public.bidder_claim_summary WHERE id = $1' INTO seen_parsed, seen_scope USING c;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt = 0 THEN
      PERFORM pg_temp.gh2988_log('S3b bidder_claim_summary shows no old summary', true, 'the view does not list this claim at all', true);
    ELSE
      PERFORM pg_temp.gh2988_log('S3b bidder_claim_summary shows no old summary', seen_parsed IS NULL AND seen_scope IS NULL,
        format('view row present; parsed_line_items=%s scope=%s', CASE WHEN seen_parsed IS NULL THEN 'NULL' ELSE 'PRESENT' END,
               CASE WHEN seen_scope IS NULL THEN 'NULL' ELSE 'PRESENT' END));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.gh2988_log('S3b bidder_claim_summary shows no old summary', false, 'could not query the view: ' || SQLSTATE || ' ' || left(SQLERRM, 100), true);
  END;

  -- ---------- S2 swap as the homeowner (role authenticated), from a freshly populated fixture ----------
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.claims SET ready_for_bids = true, estimate_filename = OLD_FILE, has_estimate = true,
         parsed_line_items = good, loss_sheet_parsed_at = now(), contractor_scope_summary = 'gh2988 scope summary',
         loss_sheet_parse_status = 'parsed'
   WHERE id = c;
  PERFORM set_config('session_replication_role', 'origin', true);
  res := pg_temp.gh2988_try_as(owner_id, format('UPDATE public.claims SET estimate_filename = %L WHERE id = %L', NEW_FILE, c), 'authenticated');
  SELECT * INTO rec FROM public.claims WHERE id = c;
  IF res = 'ACCEPTED' THEN
    ok := rec.estimate_filename = NEW_FILE AND rec.loss_sheet_parsed_at IS NULL AND rec.parsed_line_items IS NULL
          AND rec.contractor_scope_summary IS NULL AND rec.loss_sheet_parse_status IS NULL;
    PERFORM pg_temp.gh2988_log('S2 swap as the owner (authenticated): accepted and all four parse columns nulled', ok,
      format('%s; parsed_at=%s items=%s scope=%s status=%s', res, rec.loss_sheet_parsed_at, rec.parsed_line_items IS NOT NULL,
             rec.contractor_scope_summary IS NOT NULL, rec.loss_sheet_parse_status));
  ELSE
    PERFORM pg_temp.gh2988_log('S2 swap as the owner (authenticated)', true,
      format('%s; a different guard or RLS refused the owner write, so this path is not covered by this proof (S1 covers the trigger)', res), true);
  END IF;

  -- ---------- N1 negative control C: guard disabled -> the same swap leaves the stale summary readable ----------
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.claims SET ready_for_bids = true, estimate_filename = OLD_FILE, has_estimate = true,
         parsed_line_items = good, loss_sheet_parsed_at = now(), contractor_scope_summary = 'gh2988 scope summary',
         loss_sheet_parse_status = 'parsed'
   WHERE id = c;
  PERFORM set_config('session_replication_role', 'origin', true);
  ALTER TABLE public.claims DISABLE TRIGGER claims_guard_a0_parse_state;
  UPDATE public.claims SET estimate_filename = NEW_FILE WHERE id = c;
  SELECT * INTO rec FROM public.claims WHERE id = c;
  ok := rec.estimate_filename = NEW_FILE AND rec.loss_sheet_parsed_at IS NOT NULL AND rec.parsed_line_items IS NOT DISTINCT FROM good
        AND rec.contractor_scope_summary IS NOT NULL;
  PERFORM pg_temp.gh2988_log('N1 negative control: with the guard disabled the same swap leaves the OLD summary readable', ok,
    format('parsed_at_set=%s items_kept=%s scope_kept=%s (expect all true: stale; this is what S1 would show without the guard)',
           rec.loss_sheet_parsed_at IS NOT NULL, rec.parsed_line_items IS NOT DISTINCT FROM good, rec.contractor_scope_summary IS NOT NULL));
  ALTER TABLE public.claims ENABLE TRIGGER claims_guard_a0_parse_state;

  PERFORM pg_temp.gh2988_log('Z guard re-enabled before rollback', (SELECT tgenabled <> 'D' FROM pg_trigger
     WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_a0_parse_state'), 'transaction rolls back next regardless');
END
$proof$;

SELECT n, check_id, result, detail FROM gh2988_results
UNION ALL
SELECT 1000, 'OVERALL',
       CASE WHEN EXISTS (SELECT 1 FROM gh2988_results WHERE result = 'FAIL') THEN 'FAIL'
            WHEN (SELECT count(*) FROM gh2988_results WHERE result = 'PASS') >= 5 THEN 'PASS'
            ELSE 'FAIL' END,
       (SELECT count(*) FROM gh2988_results WHERE result = 'PASS') || ' PASS, ' ||
       (SELECT count(*) FROM gh2988_results WHERE result = 'FAIL') || ' FAIL, ' ||
       (SELECT count(*) FROM gh2988_results WHERE result = 'INFO') || ' INFO'
ORDER BY 1;

ROLLBACK;
