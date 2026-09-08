-- ROLLBACK HALF — gh-1759 / claims.platform_fee_stripe_id + platform_fee_amount backfill
-- MARKER: GH1759_FEEID_BACKFILL_ROLLBACK
--
-- Restores the exact pre-state measured on production 2026-09-07 (read-only):
--   claims 82f5dff4-5867-4b7a-88ca-942ce9bfe867
--     platform_fee_stripe_id = NULL
--     platform_fee_amount    = NULL
--     platform_fee_charged   = true    -- NOT touched by either half
-- Every other claim row was NULL/NULL before and after, so there is nothing
-- else to undo. This rollback is EXACT, not approximate: the forward half wrote
-- two columns on one row and both were verifiably NULL beforehand.
--
-- NOTE ON ORDER OF OPERATIONS. If the code half has been deployed and a charge
-- has settled since, that new row's charge id was written by the WRITER, not by
-- the backfill, and this file must not touch it. The guard below is what
-- enforces that: it aborts on any value other than the one the backfill wrote.

BEGIN;

-- Guard: only undo the value this backfill wrote. A different value means a real
-- writer has landed — abort rather than clobber it.
DO $$
DECLARE v text;
BEGIN
  SELECT platform_fee_stripe_id INTO v FROM public.claims
   WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867';
  IF v IS NOT NULL AND v <> 'ch_3UAdlB0AJRnqIYPU0vC3SeiG' THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_ROLLBACK aborted: unexpected value %', v;
  END IF;
END $$;

UPDATE public.claims
   SET platform_fee_stripe_id = NULL,
       platform_fee_amount    = NULL
 WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867'
   AND platform_fee_stripe_id = 'ch_3UAdlB0AJRnqIYPU0vC3SeiG';

-- Post-check: scoped to THIS row, not to the whole table. A table-wide
-- "count(platform_fee_stripe_id) = 0" assertion would fail spuriously once the
-- code-half writer has legitimately filled the column on a newer claim.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims
   WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867'
     AND (platform_fee_stripe_id IS NOT NULL OR platform_fee_amount IS NOT NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'GH1759_FEEID_BACKFILL_ROLLBACK post-check failed: target row still populated';
  END IF;
END $$;

COMMIT;
