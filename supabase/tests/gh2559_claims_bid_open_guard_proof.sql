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
-- Schema: parse status column (additive; NULL on every existing row).
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS loss_sheet_parse_status text;
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_loss_sheet_parse_status_check;
ALTER TABLE public.claims ADD CONSTRAINT claims_loss_sheet_parse_status_check
  CHECK (loss_sheet_parse_status IS NULL OR loss_sheet_parse_status IN ('parsed', 'unsupported', 'failed'));

-- Condition 1 predicate.
CREATE OR REPLACE FUNCTION public.gh2559_estimate_is_read(p_parsed jsonb, p_parsed_at timestamptz)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    p_parsed_at IS NOT NULL
    AND jsonb_typeof(p_parsed) = 'object'
    AND (
      (jsonb_typeof(p_parsed -> 'sections') = 'array' AND jsonb_array_length(p_parsed -> 'sections') > 0)
      OR (p_parsed #>> '{summary,rcv}') IS NOT NULL
    ),
    false);
$fn$;

-- Condition 2 predicate: returns 'name', 'street' or 'claim_number' for the first identity the summary repeats, else NULL.
CREATE OR REPLACE FUNCTION public.gh2559_summary_identity_hit(
  p_parsed jsonb, p_scope text, p_names text[], p_address text, p_claim_number text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  hay   text[] := ARRAY[]::text[];   -- every text value, folded: ' word word '
  raw   text[] := ARRAY[]::text[];   -- every text value, folded and stripped of all non-alphanumerics
  nums  text[] := ARRAY[]::text[];   -- every numeric value, digits only
  leaf  jsonb;
  s     text;
  nm    text;
  toks  text[];
  ft    text;
  lt    text;
  st    text[];
  cn    text;
  i     int;
BEGIN
  IF p_scope IS NOT NULL THEN
    s := ' ' || btrim(regexp_replace(lower(p_scope), '[^[:alnum:]]+', ' ', 'g')) || ' ';
    hay := hay || s;  raw := raw || regexp_replace(lower(p_scope), '[^[:alnum:]]', '', 'g');
  END IF;
  IF p_parsed IS NOT NULL THEN
    FOR leaf IN SELECT v FROM jsonb_path_query(p_parsed, 'strict $.**') AS v LOOP
      IF jsonb_typeof(leaf) = 'string' THEN
        s := leaf #>> '{}';
        hay := hay || (' ' || btrim(regexp_replace(lower(s), '[^[:alnum:]]+', ' ', 'g')) || ' ');
        raw := raw || regexp_replace(lower(s), '[^[:alnum:]]', '', 'g');
      ELSIF jsonb_typeof(leaf) = 'number' THEN
        nums := nums || regexp_replace(leaf #>> '{}', '[^0-9]', '', 'g');
      END IF;
    END LOOP;
  END IF;

  -- name: two words of 2+ letters; the first and last word next to each other (at most one word, a middle name or initial, between), in either order
  IF p_names IS NOT NULL THEN
    FOREACH nm IN ARRAY p_names LOOP
      IF nm IS NULL THEN CONTINUE; END IF;
      toks := ARRAY(SELECT t FROM unnest(regexp_split_to_array(btrim(regexp_replace(lower(nm), '[^[:alnum:]]+', ' ', 'g')), ' ')) AS t
                     WHERE length(t) >= 2);
      IF cardinality(toks) >= 2 AND toks[1] <> toks[cardinality(toks)] THEN
        ft := toks[1];  lt := toks[cardinality(toks)];
        FOREACH s IN ARRAY hay LOOP
          IF s ~ (' ' || ft || ' (\S+ )?' || lt || ' ') OR s ~ (' ' || lt || ' (\S+ )?' || ft || ' ') THEN RETURN 'name'; END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- street: the house number followed by the first street word (the part before the first comma)
  IF p_address IS NOT NULL THEN
    st := regexp_split_to_array(btrim(regexp_replace(lower(split_part(p_address, ',', 1)), '[^[:alnum:]]+', ' ', 'g')), ' ');
    IF cardinality(st) >= 2 AND st[1] ~ '^[0-9]+$' AND st[2] <> '' THEN
      ft := ' ' || st[1] || ' ' || st[2] || ' ';
      FOREACH s IN ARRAY hay LOOP
        IF position(ft IN s) > 0 THEN RETURN 'street'; END IF;
      END LOOP;
    END IF;
  END IF;

  -- claim number: 6+ characters with a digit
  cn := regexp_replace(lower(COALESCE(p_claim_number, '')), '[^[:alnum:]]', '', 'g');
  IF length(cn) >= 6 AND cn ~ '[0-9]' THEN
    FOREACH s IN ARRAY raw LOOP
      IF position(cn IN s) > 0 THEN RETURN 'claim_number'; END IF;
    END LOOP;
    IF cn ~ '^[0-9]+$' THEN
      FOREACH s IN ARRAY nums LOOP
        IF s = cn THEN RETURN 'claim_number'; END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.claims_guard_bid_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- PLACEHOLDER (not homeowner-visible: the client shows its existing generic failure line and never prints this).
  -- The sentence a homeowner is told on a refused submit is Ben's wording (#2569 6029315131 A). Do not ship a final string without him.
  c_unread   constant text := '[gh2559-bid-open:unread_estimate] PLACEHOLDER-PENDING-BEN: the uploaded estimate has not been read into a summary yet';
  c_identity constant text := '[gh2559-bid-open:identity_in_summary] PLACEHOLDER-PENDING-BEN: the estimate summary repeats the homeowner name, street address or claim number';
  v_opening boolean;
  v_owner   text;
  v_hit     text;
BEGIN
  IF NEW.ready_for_bids IS NOT TRUE THEN RETURN NEW; END IF;
  v_opening := (TG_OP = 'INSERT') OR (OLD.ready_for_bids IS NOT TRUE);

  -- Condition 1: only at the moment the claim opens.
  IF v_opening
     AND (NEW.estimate_filename IS NOT NULL OR NEW.has_estimate IS TRUE)
     AND COALESCE(NEW.loss_sheet_parse_status, '') NOT IN ('unsupported', 'failed')   -- the parser cannot read this file (type unsupported, or the provider rejected it; Q6): nothing to wait for
     AND NOT public.gh2559_estimate_is_read(NEW.parsed_line_items, NEW.loss_sheet_parsed_at) THEN
    RAISE EXCEPTION '%', c_unread USING ERRCODE = 'check_violation';
  END IF;

  -- Condition 2: at opening, and on any later change of the summary or of the identity it is compared with.
  IF NOT v_opening
     AND NEW.parsed_line_items IS NOT DISTINCT FROM OLD.parsed_line_items
     AND NEW.contractor_scope_summary IS NOT DISTINCT FROM OLD.contractor_scope_summary
     AND NEW.homeowner_name IS NOT DISTINCT FROM OLD.homeowner_name
     AND NEW.claim_number IS NOT DISTINCT FROM OLD.claim_number
     AND NEW.property_address IS NOT DISTINCT FROM OLD.property_address THEN
    RETURN NEW;
  END IF;
  IF NEW.parsed_line_items IS NULL AND NEW.contractor_scope_summary IS NULL THEN RETURN NEW; END IF;

  SELECT p.full_name INTO v_owner FROM public.profiles p WHERE p.id = NEW.user_id;
  v_hit := public.gh2559_summary_identity_hit(
             NEW.parsed_line_items, NEW.contractor_scope_summary,
             ARRAY[NEW.homeowner_name, v_owner], NEW.property_address, NEW.claim_number);
  IF v_hit IS NOT NULL THEN
    RAISE EXCEPTION '%', c_identity USING ERRCODE = 'check_violation', DETAIL = 'repeated: ' || v_hit;
  END IF;

  RETURN NEW;
END
$fn$;

-- Parse-state guard: (a) a client may not write loss_sheet_parse_status (same caller test as gh2864 / #2913: anon or authenticated,
-- JWT role not service_role, not an admin); (b) a change of estimate_filename clears the old parse.
CREATE OR REPLACE FUNCTION public.claims_estimate_parse_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_old_status text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.loss_sheet_parse_status END;
BEGIN
  -- Only the platform writes the parse results. A client that could type loss_sheet_parsed_at / parsed_line_items / contractor_scope_summary
  -- (authenticated holds column UPDATE on them) could forge a "read" estimate and skip condition 1 (review 6277230163, F1/F1b).
  IF (NEW.loss_sheet_parse_status IS DISTINCT FROM v_old_status
      OR NEW.loss_sheet_parsed_at IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD.loss_sheet_parsed_at END
      OR NEW.parsed_line_items IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD.parsed_line_items END
      OR NEW.contractor_scope_summary IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD.contractor_scope_summary END)
     AND current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    RAISE EXCEPTION 'claims: the parse results (loss_sheet_parse_status, loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary) can only be written by the platform (gh-2559)'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.estimate_filename IS DISTINCT FROM OLD.estimate_filename THEN
    IF NEW.loss_sheet_parsed_at IS NOT DISTINCT FROM OLD.loss_sheet_parsed_at THEN NEW.loss_sheet_parsed_at := NULL; END IF;
    IF NEW.parsed_line_items IS NOT DISTINCT FROM OLD.parsed_line_items THEN NEW.parsed_line_items := NULL; END IF;
    IF NEW.contractor_scope_summary IS NOT DISTINCT FROM OLD.contractor_scope_summary THEN NEW.contractor_scope_summary := NULL; END IF;
    IF NEW.loss_sheet_parse_status IS NOT DISTINCT FROM OLD.loss_sheet_parse_status THEN NEW.loss_sheet_parse_status := NULL; END IF;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.claims_estimate_parse_state_guard() IS
  'gh-2559: BEFORE INSERT OR UPDATE OF estimate_filename and the four parse-result columns on public.claims. Refuses (42501) a client write of loss_sheet_parse_status, loss_sheet_parsed_at, parsed_line_items or contractor_scope_summary; clears the previous parse (loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary, loss_sheet_parse_status) when estimate_filename changes, unless the same statement set them.';

REVOKE EXECUTE ON FUNCTION public.claims_estimate_parse_state_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gh2559_estimate_is_read(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gh2559_summary_identity_hit(jsonb, text, text[], text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claims_guard_bid_open() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS claims_guard_a0_parse_state ON public.claims;

-- Named so that BEFORE triggers (fired in name order) run it before claims_guard_bid_open in the same statement.
CREATE TRIGGER claims_guard_a0_parse_state
  BEFORE INSERT OR UPDATE OF estimate_filename, loss_sheet_parse_status, loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary
  ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.claims_estimate_parse_state_guard();

DROP TRIGGER IF EXISTS claims_guard_bid_open ON public.claims;

CREATE TRIGGER claims_guard_bid_open
  BEFORE INSERT OR UPDATE OF ready_for_bids, estimate_filename, has_estimate, loss_sheet_parsed_at, parsed_line_items,
                             contractor_scope_summary, homeowner_name, claim_number, property_address
  ON public.claims
  FOR EACH ROW
  WHEN (NEW.ready_for_bids IS TRUE)
  EXECUTE FUNCTION public.claims_guard_bid_open();
$fwd$;
  rb text := $rb$
DROP TRIGGER IF EXISTS claims_guard_bid_open ON public.claims;
DROP TRIGGER IF EXISTS claims_guard_a0_parse_state ON public.claims;
DROP FUNCTION IF EXISTS public.claims_estimate_parse_state_guard();
DROP FUNCTION IF EXISTS public.claims_guard_bid_open();
DROP FUNCTION IF EXISTS public.gh2559_summary_identity_hit(jsonb, text, text[], text, text);
DROP FUNCTION IF EXISTS public.gh2559_estimate_is_read(jsonb, timestamptz);

-- Removes the additive column (and its CHECK). Any 'parsed' / 'unsupported' / 'failed' marks written since the apply are lost; they are
-- re-derivable by re-running parse-loss-sheet with the service role (a claim that was open only because of an 'unsupported' or 'failed' mark has no parse again afterwards, so it is refused on its next opening until re-parsed). parse-loss-sheet writes this column, so redeploy the pre-gh2559
-- version of that function BEFORE running this file, or its parse writes fail.
ALTER TABLE public.claims DROP COLUMN IF EXISTS loss_sheet_parse_status;
$rb$;
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
