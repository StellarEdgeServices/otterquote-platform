-- Migration: 20260618130000_p15_quotes_fee_amount_normalize
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit MIG-C (U15-4 Part 1)
-- Date: 2026-06-18
-- D-numbers: D-211 P15 (U15-4 Part 1 — quotes.fee_amount server-side normalization);
--            references D-199 (bid_can_submit BEFORE-INSERT gate — independent, see note below)
-- Rollback: 20260618130000_p15_quotes_fee_amount_normalize_rollback.sql
--
-- Summary: ADDITIVE — installs a BEFORE INSERT OR UPDATE row-level trigger on quotes that
--          forces fee_amount to ALWAYS equal the platform fee CHARGE BASIS, computed
--          server-side as round((platform_fee_pct / 100.0) * total_price, 2).
--
--          Why: quotes.fee_amount is a denormalized display/disclosure column written at
--          bid submission. The actual fee CHARGE is computed independently by the revenue
--          path (docusign-webhook + create-payment-intent) as platform_fee_pct% × total_price;
--          the charge never reads fee_amount. fee_amount can therefore drift from the charge
--          basis when platform_fee_pct <> 5% or when an insurance RCV base <> total_price.
--          Live today: 0 mismatches (all quotes at 5%), so the drift is latent. This trigger
--          makes the display value provably equal the charge basis going forward.
--
--          Scope guarantees:
--            * Touches ONLY quotes.fee_amount, and only the value written into it.
--            * Does NOT alter platform_fee_pct, total_price, fee_percentage, any constraint,
--              or any column type/default. No legal/disclosure copy is involved.
--            * Computes nothing when platform_fee_pct IS NULL or total_price IS NULL — in that
--              case NEW.fee_amount is left exactly as supplied (fee_amount is NOT NULL, so the
--              caller's value still satisfies the column constraint).
--
--          Independence from D-199 (sql/v65-d199-bid-can-submit.sql):
--            The existing trigger quotes_enforce_bid_can_submit -> enforce_bid_can_submit()
--            is BEFORE INSERT and only RAISEs to GUARD bids; it never reads or writes
--            fee_amount. This trigger only SETS a column and never raises. The two cannot
--            conflict. Postgres fires BEFORE-row triggers in trigger-name order, so on INSERT
--            'quotes_enforce_bid_can_submit' runs before 'quotes_normalize_fee_amount'; if the
--            D-199 gate aborts, normalization simply never runs — the correct outcome.
--
--          Locking: CREATE TRIGGER takes a brief ACCESS EXCLUSIVE lock on quotes for the
--          catalog change only (no table rewrite). The backfill is a no-op today (0 rows).

BEGIN;

-- 1. Normalization function: pins fee_amount to the charge basis on every write.
--    No SECURITY DEFINER needed (operates only on NEW); search_path pinned for the linter.
CREATE OR REPLACE FUNCTION public.normalize_quotes_fee_amount()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
BEGIN
  -- Only normalize when both inputs are present; otherwise leave NEW.fee_amount as-is.
  IF NEW.platform_fee_pct IS NOT NULL AND NEW.total_price IS NOT NULL THEN
    NEW.fee_amount := round((NEW.platform_fee_pct / 100.0) * NEW.total_price, 2);
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Trigger: fires BEFORE INSERT OR UPDATE on quotes, normalizing every write.
--    Idempotent: drop-if-exists guards re-runs. Independent of the D-199 gate (see header).
DROP TRIGGER IF EXISTS quotes_normalize_fee_amount ON public.quotes;
CREATE TRIGGER quotes_normalize_fee_amount
  BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_quotes_fee_amount();

-- 3. One-time backfill of any pre-existing drift (no-op today — 0 rows).
--    Only corrects rows where both inputs are present AND the stored value differs.
UPDATE public.quotes
SET fee_amount = round((platform_fee_pct / 100.0) * total_price, 2)
WHERE platform_fee_pct IS NOT NULL
  AND total_price IS NOT NULL
  AND fee_amount IS DISTINCT FROM round((platform_fee_pct / 100.0) * total_price, 2);

COMMIT;
