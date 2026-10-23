-- STATUS (gh-1438, as of 2026-10-23T13:27:30Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2997_inherit_is_test (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-23 under #2997. Production read-only 2026-10-23 (project yeszghaspzwwstvsrioa): quotes.is_test and
--   activity_log.is_test are boolean NOT NULL DEFAULT false; no trigger on quotes or activity_log sets is_test from the claim;
--   2 quotes (403940dc-bf8d-423f-92ba-0652ce2d5f67, 471b2b5a-fb94-4558-aaf7-aa1670d000a2) sit on is_test claims with is_test=false;
--   6 activity_log rows whose metadata.claim_id is an is_test claim have is_test=false. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2997_inherit_is_test
-- GitHub: #2997. Tier: 3A for the two triggers (additive, no external side effect, no RLS change); the one-off data correction
--   updates 2 quotes rows and the claim-linked activity_log rows, all on is_test claims, so the whole file is filed as Tier 3 (R-097).
-- Rollback: supabase/migrations_drafts/gh2997_inherit_is_test_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2997_inherit_is_test_pre-flight.md
-- Proof: supabase/tests/gh2997_inherit_is_test_proof.sql (BEGIN ... forced ROLLBACK) and tests/gh2997-static-inherit-is-test.mjs
--
-- Why: the contractor bid form (contractor-bid-form.html and the React twin) never sends quotes.is_test, so every bid on an is_test
-- claim lands with the column default false. log_bid_submitted()/log_bid_accepted() copy NEW.is_test (gh-1028), so the
-- bid_submitted/bid_accepted activity_log rows inherit the wrong value. gh-1028 (20260818224203) and gh-945 (20260820214050) fixed
-- the rows that existed then; neither added a write-time rule, so the defect recurred (quote 471b2b5a, 2026-10-21).
-- Rule: a row inherits is_test from its claim at write time; the rule only ever raises false to true, never lowers a true.
-- activity_log has no claim_id column: the join key is metadata->>'claim_id' (and metadata->>'quote_id' for quote-linked rows).

-- CREATE OR REPLACE TRIGGER (PG14+) is idempotent and takes SHARE ROW EXCLUSIVE, not the ACCESS EXCLUSIVE of DROP TRIGGER: a
-- DROP TRIGGER IF EXISTS on public.activity_log hung >230 s on 2026-10-23 in the rolled-back proof (see pre-flight), so it is not used.

BEGIN;

-- 1. quotes: copy claims.is_test onto the new quote.
CREATE OR REPLACE FUNCTION public.quotes_inherit_is_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT COALESCE(NEW.is_test, false) THEN
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id = NEW.claim_id AND c.is_test IS TRUE) THEN
      NEW.is_test := true;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'quotes_inherit_is_test failed for claim %: % (%)', NEW.claim_id, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.quotes_inherit_is_test() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER quotes_inherit_is_test
  BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_inherit_is_test();

-- 2. activity_log: inherit from the claim (or quote) named in metadata. Covers the bid triggers and every Edge Function insert
--    that carries metadata.claim_id. A row with no resolvable claim/quote key is left exactly as written.
CREATE OR REPLACE FUNCTION public.activity_log_inherit_is_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claim text;
  v_quote text;
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF NOT COALESCE(NEW.is_test, false) AND jsonb_typeof(NEW.metadata) = 'object' THEN
    v_claim := NEW.metadata ->> 'claim_id';
    v_quote := NEW.metadata ->> 'quote_id';
    IF v_claim ~ c_uuid
       AND EXISTS (SELECT 1 FROM public.claims c WHERE c.id = v_claim::uuid AND c.is_test IS TRUE) THEN
      NEW.is_test := true;
    ELSIF v_quote ~ c_uuid
       AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = v_quote::uuid AND q.is_test IS TRUE) THEN
      NEW.is_test := true;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'activity_log_inherit_is_test failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.activity_log_inherit_is_test() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER activity_log_inherit_is_test
  BEFORE INSERT ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.activity_log_inherit_is_test();

-- 3. One-off data correction. Raises false to true only, only where the parent claim (or quote) is is_test. Quotes first, so the
--    activity_log pass sees the corrected quotes.
UPDATE public.quotes q
   SET is_test = true
  FROM public.claims c
 WHERE c.id = q.claim_id AND c.is_test IS TRUE AND q.is_test IS NOT TRUE;

UPDATE public.activity_log al
   SET is_test = true
 WHERE al.is_test IS NOT TRUE
   AND jsonb_typeof(al.metadata) = 'object'
   AND (
     (al.metadata ->> 'claim_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.claims c WHERE c.id = (al.metadata ->> 'claim_id')::uuid AND c.is_test IS TRUE))
     OR
     (al.metadata ->> 'quote_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = (al.metadata ->> 'quote_id')::uuid AND q.is_test IS TRUE))
   );

COMMIT;
