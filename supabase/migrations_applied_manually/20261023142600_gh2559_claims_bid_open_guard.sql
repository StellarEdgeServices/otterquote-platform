-- >>> APPLIED MANUALLY, NO LEDGER ROW (gh-1438, filed 2026-10-23T16:44:20Z) <<<
-- Applied to production (yeszghaspzwwstvsrioa) on 2026-10-23 at about 14:26Z (filename seconds are 00: the minute is from the apply record, the second is not recorded), via the Supabase Management API,
-- not via the migration ledger. Record: forward applied at about 14:26Z via the Supabase Management API (HTTP 201), file sha256 145e064f... = the draft at 9a5aee80; NO schema_migrations row (SELECT on 2026-10-23: no row mentions it).
-- sha256 of the applied file = sha256 of everything BELOW the next line (the draft as it stood at apply, STATUS header included): 145e064fd77d14cd8c405132cfbdfd32dfb712808e1140ecbe135ba559893664
-- The STATUS line below is the draft-time header and is SUPERSEDED by this block. Never move this file into supabase/migrations/ and never give it a
-- schema_migrations row on that basis alone (see supabase/migrations/README.md, migrations_applied_manually). Not run by any automation.
-- ---- BEGIN APPLIED BYTES ----
-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claims_bid_open_guard (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-19 by CTO RUN 72 (tid cto72-b2559) under #2559 against Ben's binding amendment, #2569 comment 6029315131 sections A and B.4, and CLOSE-REVIEW 6171768416 / 6275976815. Read-only production reads the same day: public.claims has 14 triggers and none is a bid-open gate; pg_proc has 0 functions whose name matches %bid_release% or %bid_open%; claims 34, of which 14 open for bids, 4 of them with an estimate and no loss_sheet_parsed_at (grandfathered, see the pre-flight); claims.claim_number is set on 0 claims, claims.homeowner_name on 9, profiles.full_name on 31 of 34. No database was written to produce this file. The behaviour run on a throwaway Postgres is tools/gh2559-bid-open-guard-behaviour.py.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_claims_bid_open_guard
-- GitHub: #2559 (named remaining part of its closes-on, Ben 6029315131 A and B.4). Tier: 3B (it can REFUSE a homeowner write on public.claims).
-- Rollback: supabase/migrations_drafts/gh2559_claims_bid_open_guard_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_claims_bid_open_guard_pre-flight.md
-- Proof: supabase/tests/gh2559_claims_bid_open_guard_proof.sql
--
-- WHAT THE AMENDMENT SAYS. "The two conditions it was meant to enforce (no bid opens on an unread estimate; no identity in a summary)".
-- "It" is the bid-release trigger Ben cut out of #2569 (heads 2e130cde and c60b216f, claims_guard_bid_release). "A bid opens" there means the
-- CLAIM opens for bidding (claims.ready_for_bids false/NULL -> true, which is how dashboard.html:3231 and actions.ts:41 submit), NOT a contractor
-- creating a quote. "Unread" means the uploaded estimate has not been read into the summary a bidder prices from (claims.loss_sheet_parsed_at /
-- parsed_line_items, written by the parse-loss-sheet function). "A summary" is what bidder_claim_summary hands every bidder:
-- parsed_line_items and contractor_scope_summary. Nothing in the repo records that a CONTRACTOR "read" an estimate, and since #2569 a bidder
-- can read no raw file at all, so a per-contractor read gate has nothing to key on; it is NOT built (open question Q1 in the pre-flight).
--
-- CONDITION 1, no bid opens on an unread estimate. On the false/NULL -> true change of ready_for_bids (and on INSERT with it true), when the claim
-- carries an uploaded estimate (estimate_filename is set or has_estimate is true), the estimate must be READ: loss_sheet_parsed_at is set AND
-- parsed_line_items is a JSON object with a non-empty sections array or a summary.rcv. NULL-safe (the c60b216f version let {} and
-- {"error":...} through, review 6024856617 finding 4). A claim with no estimate file is not touched.
-- CONDITION 2, no identity in a summary. When the claim opens, and afterwards whenever parsed_line_items, contractor_scope_summary,
-- homeowner_name, claim_number or property_address changes on an open claim (finding 3: the first version checked only the opening), the summary
-- must not repeat the owner's name, the street line, or the claim number. Identity comes from claims.homeowner_name AND profiles.full_name
-- (finding 2: homeowner_name is empty on 22 of 31 named owners and claim_number on every claim). Matching is on whole words after folding case,
-- punctuation and spacing (finding 5): a name needs two words of 2+ letters standing next to each other (one middle word or initial allowed, either order), so "Tom Hail"
-- does not fire on "hail damage" or "Park Ridge" on "ridge cap, park side", while "Last, First M.", a double space, a line break and an upper-case name all do); a street needs its house number followed by its first street
-- word (so "Court" vs "Ct" and a missing comma do not matter, and a street with no house number is not checked); a claim number needs 6+ characters with
-- a digit, compared with spaces and dashes removed against text values, and against a numeric value only when it equals the whole number
-- (so a price or quantity never collides). Prices and quantities are never matched as names or streets (numbers are not text).
--
-- REVIEW 6276857463 CHANGES (Marty's rulings, Tier A, 2026-10-19):
--  (1) A file the platform cannot read must not trap the claim. parse-loss-sheet now sends JPG/PNG as image blocks (it sent every file as
--      application/pdf) and, for a type the provider genuinely cannot read (Word, HEIC, anything else), writes the new column
--      claims.loss_sheet_parse_status = 'unsupported' and an operator row in platform_alerts_log. Condition 1 treats 'unsupported' as
--      "nothing readable to wait for": the claim may open, and since no summary exists the bidder sees none of the estimate's fields. Only
--      the platform (service_role / admin / owner-level functions) may write that column AND the three parse results it stands beside
--      (loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary); a client write of any of them is refused 42501, otherwise a
--      homeowner could skip condition 1 by typing a status or a fake parse (review 6277230163 F1/F1b; grep: no client code writes them).
--      The provider rejecting a file (HTTP 400/413: corrupt or encrypted PDF, truncated image, over its limits) is recorded the same way
--      as status 'failed' + platform_alerts_log 'loss_sheet_parse_failed', and condition 1 treats 'failed' like 'unsupported'. Q6 for Ben (default built: allow open + admin alert). Re-trigger a parse:
--      call parse-loss-sheet with the service-role bearer and {claim_id, storage_path} (its existing service-role path).
--  (2) Replacing the estimate resets the parse. Any change of estimate_filename clears loss_sheet_parsed_at, parsed_line_items,
--      contractor_scope_summary and loss_sheet_parse_status (each only if the same statement did not set it), so an old parse can never
--      satisfy condition 1 for a new file. It is a separate BEFORE trigger, claims_guard_a0_parse_state, named to sort before
--      claims_guard_bid_open. Side effect on an OPEN claim: a replaced estimate shows no summary until the new file is parsed.
--  (3) The React client never shows the guard's database text (actions.ts); see the PR.
--
-- WHAT IS NOT DONE HERE, each recorded as a question in the pre-flight: the words a homeowner is told when this refuses (Ben, 6029315131 A:
-- consent and trust wording, comes to him first) -- the message below is a marked PLACEHOLDER and the client shows only the existing generic
-- failure; replacing an estimate on an ALREADY OPEN claim with an unparsed one (not refused: it would block a homeowner's upload); the four
-- grandfathered open claims; the parser-side redaction (D-390, #2880).
--
-- Separate triggers and separate functions; no existing function or trigger is edited. One additive column (loss_sheet_parse_status). BEFORE triggers fire in name order, so
-- claims_guard_bid_open runs after claims_guard_award_columns; it never changes NEW.
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- Apply order: the dashboard.html / actions.ts change in the same PR (waits for the parse before it submits) is published FIRST, then this file.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $gate$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'claims'
         AND column_name IN ('ready_for_bids','estimate_filename','has_estimate','loss_sheet_parsed_at','parsed_line_items',
                             'contractor_scope_summary','homeowner_name','claim_number','property_address','user_id')) <> 10 THEN
    RAISE EXCEPTION 'gh2559 bid-open guard: a claims column this file reads is missing; refusing to apply';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name IN ('id','full_name')) <> 2 THEN
    RAISE EXCEPTION 'gh2559 bid-open guard: profiles.id / full_name missing; refusing to apply';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2559 bid-open guard: public.is_admin_email() does not exist; refusing to apply';
  END IF;
END
$gate$;

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

COMMENT ON FUNCTION public.claims_guard_bid_open() IS
  'gh-2559 (Ben 6029315131 A/B.4): BEFORE INSERT OR UPDATE trigger function on public.claims. When a claim opens for bids with an uploaded estimate that has not been read into a summary, or when the summary repeats the owner name / street / claim number, raises check_violation with a PLACEHOLDER message. Also re-checks identity when the summary or the identity columns change on an open claim. Never changes NEW.';

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

COMMIT;
