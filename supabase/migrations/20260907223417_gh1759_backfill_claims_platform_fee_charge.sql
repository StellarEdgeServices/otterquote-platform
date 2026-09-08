-- FORWARD HALF — gh-1759 / claims.platform_fee_stripe_id + platform_fee_amount backfill
-- MARKER: GH1759_FEEID_BACKFILL_FORWARD
--
-- Filename timestamp transcribed from a pasted stamp.py clock read
-- (UTC 2026-09-07T22:34:17Z), not typed from a wall clock — R-140.
--
-- ⛔ TIER 3B. NOT APPLIED BY THE PR THAT ADDS THIS FILE. Requires the R-097
--    window on issue #1759 to have elapsed AND `tier:3b-approved` on that issue.
--
-- WHY. supabase/functions/stripe-webhook/index.ts:422 resolves a
-- charge.dispute.created event to a claim via
--   .eq("platform_fee_stripe_id", dispute.charge)
-- and until the code half of this change no path in the repository ever WROTE
-- that column. Measured on production 2026-09-07 (read-only):
--   total claims                                      16
--   claims with a non-null platform_fee_stripe_id       0
--   claims with a non-null platform_fee_amount          0
--   claims with platform_fee_charged = true             1
--   claims charged but with no charge id recorded       1   <-- this row
--
-- The CODE half of #1759 makes every FUTURE fee charge write these columns.
-- This file exists only for the ONE historical row that was charged before the
-- writer existed. It is not the fix; it is the cleanup behind the fix. The
-- issue's second closes-on query is what distinguishes the two, and a run of
-- this script alone will fail it on the next settled charge.
--
-- EVIDENCE for the values (Stripe live API, read-only, rk_live_ read key,
-- captured 2026-09-06 by CTO RUN 27 and unchanged since — Stripe
-- GET /v1/charges?limit=100 returns 7 charges, has_more:false, newest still
-- ch_3UAdlB0AJRnqIYPU0vC3SeiG 2026-08-31):
--   PI  pi_3UAdlB0AJRnqIYPU0PukNRsR   status=succeeded amount=18054 livemode=true
--   latest_charge = ch_3UAdlB0AJRnqIYPU0vC3SeiG
--   metadata.platform_fee_cents = 17500   (card_fee_cents = 554, EXCLUDED)
--   metadata.claim_id = 82f5dff4-5867-4b7a-88ca-942ce9bfe867
-- Cross-check against our own records: public.quotes
--   7ceed80e-a294-4a38-9cc1-bbfe3fb3a923 has
--   payment_intent_id = pi_3UAdlB0AJRnqIYPU0PukNRsR and fee_amount = 175.00.
--
-- WHY 175.00 AND NOT 180.54. claims.platform_fee_amount is numeric(10,2) in
-- DOLLARS and the established row convention is the FEE, not the surcharged
-- total: quotes.fee_amount = 175.00 for this same charge. The $5.54 difference
-- is the card passthrough, which is not a platform fee. The code half follows
-- the same convention (create-payment-intent returns platform_fee_cents, which
-- excludes the surcharge), so backfilled and newly written rows agree.
--
-- Derived from In Flight/sql/20260906-cto27-backfill-claims-platform-fee-charge-forward.sql
-- (CTO RUN 27), re-verified against production this run: guard 1's predicate
-- returns exactly 1 row as of 2026-09-07.
--
-- SCOPE: exactly 1 row, 2 columns. No DDL. No schema change. No other table.

BEGIN;

-- Guard 1: refuse unless the target row is in the exact expected pre-state.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims
   WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867'
     AND platform_fee_charged IS TRUE
     AND platform_fee_stripe_id IS NULL
     AND platform_fee_amount IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_FORWARD aborted: expected 1 row in pre-state, found %', n;
  END IF;
END $$;

-- Guard 2: refuse if ANY claim already carries a charge id. That would mean the
-- code-half writer has already landed and settled a charge, making this script
-- stale — and a stale backfill is exactly how a wrong charge id gets written.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims WHERE platform_fee_stripe_id IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_FORWARD aborted: % claim(s) already have platform_fee_stripe_id', n;
  END IF;
END $$;

UPDATE public.claims
   SET platform_fee_stripe_id = 'ch_3UAdlB0AJRnqIYPU0vC3SeiG',
       platform_fee_amount    = 175.00
 WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867'
   AND platform_fee_stripe_id IS NULL
   AND platform_fee_amount IS NULL;

-- Post-check A: the dispute lookup this whole issue is about now resolves.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims
   WHERE platform_fee_stripe_id = 'ch_3UAdlB0AJRnqIYPU0vC3SeiG';
  IF n <> 1 THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_FORWARD post-check A failed: % rows resolve by charge id', n;
  END IF;
END $$;

-- Post-check B: the issue's second closes-on query is now 0. It must STAY 0
-- after the next settled charge — that is the code half's job, not this file's.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims
   WHERE platform_fee_charged IS TRUE AND platform_fee_stripe_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_FORWARD post-check B failed: % charged claim(s) still have no charge id', n;
  END IF;
END $$;

COMMIT;
