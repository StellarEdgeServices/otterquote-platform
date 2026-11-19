-- STATUS (gh-1438, as of 2026-11-16T14:15:14Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3783_claims_refuse_windows_trade (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted under #3783 (D-375, #2536 comment 6039706944); read-only production SELECT on project yeszghaspzwwstvsrioa in this session (before 2026-11-16T14:15:14Z) (CEO RUN 153, b3783): claims total 43, rows with a windows trade 0, rows with windows_bid_released_at 0; claims.trades is text[]
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- NOT APPLIED. Tier: 3B (new trigger on public.claims). R-097 24-hour notice before apply. Protective only (R-134).
-- Rollback: supabase/migrations_drafts/gh3783_claims_refuse_windows_trade_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh3783_claims_refuse_windows_trade_pre-flight.md
--
-- gh-3783 / D-375: Windows is "coming soon" and cannot be released to contractors until the window bid section is built
-- and Dustin says it is live. This refuses, at the database, a claim that carries a windows trade or a windows release stamp.
--
-- Change. One trigger function public.claims_refuse_windows_trade() and one trigger claims_refuse_windows_trade,
-- BEFORE INSERT OR UPDATE OF trades, windows_bid_released_at ON public.claims. It raises 23514 when NEW.trades contains
-- 'windows' (case-insensitive) or NEW.windows_bid_released_at IS NOT NULL, for every caller including service_role.
-- On UPDATE it fires only when one of those two values changes, so a row that somehow already carries windows is not
-- blocked from unrelated updates (production has 0 such rows today). No existing function, trigger, policy or grant is touched.
-- To open Windows later: apply the rollback file (drops only these two objects).
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_refuse_windows_trade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.trades IS NOT DISTINCT FROM OLD.trades
     AND NEW.windows_bid_released_at IS NOT DISTINCT FROM OLD.windows_bid_released_at THEN
    RETURN NEW;
  END IF;
  IF NEW.windows_bid_released_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(NEW.trades, ARRAY[]::text[])) AS t(x) WHERE lower(btrim(x)) = 'windows') THEN
    RAISE EXCEPTION 'claims: a windows trade cannot be saved or released yet (D-375, gh-3783)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS claims_refuse_windows_trade ON public.claims;
CREATE TRIGGER claims_refuse_windows_trade
  BEFORE INSERT OR UPDATE OF trades, windows_bid_released_at ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_refuse_windows_trade();

COMMIT;
