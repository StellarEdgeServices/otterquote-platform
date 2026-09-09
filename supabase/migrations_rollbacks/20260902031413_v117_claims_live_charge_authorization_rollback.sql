-- ROLLBACK for v117 / gh-1467.
--
-- ⚠ ORDER MATTERS. Dropping these columns while the #1467 guards are deployed
-- makes every platform-fee guard read fail, and the guards FAIL CLOSED — so a
-- rollback of the schema alone stops ALL platform-fee charges, real ones
-- included. Roll the Edge Functions back FIRST (docusign-webhook,
-- create-payment-intent, process-dunning), then run this.
--
-- The backfilled marker on claim 82f5dff4-... is dropped with the column. That
-- is acceptable: the fact it recorded is preserved in gh-1467 verbatim.

ALTER TABLE public.claims
  DROP COLUMN IF EXISTS live_charge_authorized_at,
  DROP COLUMN IF EXISTS live_charge_authorized_by;
