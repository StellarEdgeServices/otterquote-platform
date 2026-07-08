-- v90 — #514: insurance contract shows blank Insurance Co / Deductible.
-- parse-loss-sheet captures carrier_name + summary.deductible but never wrote
-- them to the claim, and create-docusign-envelope read a non-existent column
-- `insurance_carrier`. Add a nullable carrier_name text column (PII-safe: the
-- carrier company name is not personal data; claim_number stays redacted).
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS carrier_name TEXT;
COMMENT ON COLUMN public.claims.carrier_name IS
  'Insurance carrier company name parsed from the loss sheet (#514). PII-safe. Feeds the DocuSign "Insurance Co" anchor.';
