-- STATUS (gh-1438, as of 2026-11-15): NOT APPLIED
-- EVIDENCE: no trigger on public.quotes references `declarations` (pg_trigger/pg_proc SELECT, #1339 comment 6674161939, 2026-11-05); the 14 triggers on public.quotes read back 2026-11-15 (SELECT, project yeszghaspzwwstvsrioa) carry none of this name.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Tier 3A (R-097): needs the R-097 notice and a recorded apply; throwaway proof is supabase/tests/gh1339_quotes_declarations_proof_run.sh.
-- gh-1339 (D-317 cl. 2) -- DRAFT, NOT APPLIED (Tier 3A, additive).
--
-- WHAT: BEFORE INSERT OR UPDATE trigger on public.quotes. A bid on a RETAIL job that includes ROOFING (the condition under
-- which contractor-bid-form.html renders Section 2, valueAddsSection, and runs validateValueAddDeclarations(); CTO ruling
-- #1339 comment 6776723904) is refused unless scope_summary carries a `declarations` object with all five rows
-- (gutters, chimney, skylights, ice_water_shield, drip_edge), each {state, rate_cents}, state in
-- included | extra | not_offered | other, and every `extra` row has rate_cents > 0. Same rule as the form, so the browser and
-- the database cannot disagree about when sight-unseen declarations are required.
--
-- DESIGN CHOICES (each limits the chance of blocking a real bid):
--   * Keys on claims (job_type = 'retail' OR funding_type = 'cash') AND 'roofing' in claims.trades AND
--     coalesce(quotes.trade_type,'roofing') = 'roofing'. Insurance bids, auto-bids (insurance only, process-auto-bids),
--     gutter-only and siding-only bids are untouched.
--   * UPDATE is checked only when scope_summary, trade_type or claim_id changes. Status, payment, signature and webhook
--     updates never hit the check, and the 4 existing retail-roofing quotes (none has declarations, read 2026-11-15) stay
--     updatable. No backfill.
--   * Applies to every caller, service_role included (a server write must not bypass the rule either).
--   * scope_summary is text (information_schema, 2026-11-15). Non-JSON or non-object text is refused on a retail-roofing bid.
--   * New function: SECURITY DEFINER (reads claims), EXECUTE revoked from PUBLIC, anon, authenticated (migration-author
--     danger pattern 9); a trigger needs no EXECUTE grant.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.enforce_quote_section2_declarations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_applies boolean;
  v_json    jsonb;
  v_decl    jsonb;
  v_key     text;
  v_row     jsonb;
  v_bad     text[] := '{}';
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id
     AND NEW.scope_summary IS NOT DISTINCT FROM OLD.scope_summary
     AND NEW.trade_type IS NOT DISTINCT FROM OLD.trade_type THEN
    RETURN NEW;
  END IF;

  IF lower(coalesce(NEW.trade_type, 'roofing')) <> 'roofing' THEN
    RETURN NEW;
  END IF;

  SELECT (lower(coalesce(c.job_type, '')) = 'retail' OR lower(coalesce(c.funding_type, '')) = 'cash')
         AND EXISTS (SELECT 1 FROM unnest(coalesce(c.trades, '{}'::text[])) t WHERE lower(t) = 'roofing')
    INTO v_applies
    FROM public.claims c
   WHERE c.id = NEW.claim_id;

  IF v_applies IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_json := NEW.scope_summary::jsonb;
  EXCEPTION WHEN others THEN
    v_json := NULL;
  END;
  v_decl := CASE WHEN jsonb_typeof(v_json) = 'object' THEN v_json -> 'declarations' END;

  IF v_decl IS NULL OR jsonb_typeof(v_decl) <> 'object' THEN
    RAISE EXCEPTION 'Section 2 declarations required: a retail roofing bid must declare gutters, chimney, skylights, ice_water_shield and drip_edge (gh-1339)'
      USING ERRCODE = '23514';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['gutters', 'chimney', 'skylights', 'ice_water_shield', 'drip_edge'] LOOP
    v_row := v_decl -> v_key;
    IF v_row IS NULL OR jsonb_typeof(v_row) <> 'object'
       OR (v_row ->> 'state') IS NULL
       OR (v_row ->> 'state') NOT IN ('included', 'extra', 'not_offered', 'other') THEN
      v_bad := v_bad || v_key;
    ELSIF (v_row ->> 'state') = 'extra'
          AND (jsonb_typeof(v_row -> 'rate_cents') <> 'number' OR (v_row ->> 'rate_cents')::numeric <= 0) THEN
      v_bad := v_bad || (v_key || ' (extra needs rate_cents > 0)');
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Section 2 declarations incomplete: %  (gh-1339)', array_to_string(v_bad, ', ')
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_quote_section2_declarations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_require_section2_declarations ON public.quotes;
CREATE TRIGGER quotes_require_section2_declarations
BEFORE INSERT OR UPDATE ON public.quotes
FOR EACH ROW
EXECUTE FUNCTION public.enforce_quote_section2_declarations();

COMMENT ON FUNCTION public.enforce_quote_section2_declarations() IS
  'gh-1339 / D-317 cl.2: refuses a retail roofing bid (claims retail, roofing in trades, trade_type roofing) whose scope_summary lacks the five Section 2 declarations or has an extra row with rate_cents <= 0. UPDATE checked only when scope_summary, trade_type or claim_id changes. Rollback: sibling _rollback.sql.';

DO $final$
BEGIN
  IF has_function_privilege('anon', 'public.enforce_quote_section2_declarations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_quote_section2_declarations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'gh1339: a client role holds EXECUTE on the guard function; nothing is applied';
  END IF;
END
$final$;
