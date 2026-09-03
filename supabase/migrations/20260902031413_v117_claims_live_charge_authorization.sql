-- v117 / gh-1467: record DELIBERATE human authorization of a LIVE-mode charge
-- on a test claim. Additive and nullable (D-182/D-261 Tier 3A).
--
-- WHY: on 2026-08-31 a signature ceremony on a claim with is_test = true charged
-- a real card $180.54. Dustin's ruling on #1467 ("That charge was a test and
-- expected." / "Keep it") established that a LIVE charge on a test row can be
-- deliberate -- so a blanket is_test refusal would silently destroy the only way
-- to prove the fee path works. The correct predicate is not "is this a test?"
-- but "did a human authorise a live charge on this row?". Nothing in the schema
-- could express that. This column is that expression.
--
-- Absent this marker, the #1467 guards in docusign-webhook, create-payment-intent
-- and process-dunning refuse a live platform-fee charge on any is_test row.

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS live_charge_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_charge_authorized_by text;

COMMENT ON COLUMN public.claims.live_charge_authorized_at IS
  'gh-1467. Set out of band by a human to authorise LIVE-mode platform-fee charges on this claim even when is_test is true. NULL = not authorised; the fee guards refuse. Never set by application code.';
COMMENT ON COLUMN public.claims.live_charge_authorized_by IS
  'gh-1467. Who authorised the live charge, and on what record. Free text; audit trail only.';

-- Backfill the one claim this defect has already fired on, so the 2026-08-31
-- charge is legible as the deliberate act Dustin says it was rather than the
-- accident it looked like from every surface. Retroactive and explicitly marked
-- as such. Idempotent: only sets the marker if it is still NULL.
UPDATE public.claims
   SET live_charge_authorized_at = contract_signed_at,
       live_charge_authorized_by = 'dustin (retroactive, gh-1467 ruling 2026-09-01: "That charge was a test and expected." / "Keep it")'
 WHERE id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867'
   AND live_charge_authorized_at IS NULL;
