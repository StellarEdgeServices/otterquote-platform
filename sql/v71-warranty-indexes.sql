-- Migration v71: Add indexes for warranty fields
-- Supports homeowner warranty document lookup and contractor warranty upload prompt
-- Applied: 2026-05-02

-- Index 1 (quotes): Homeowner dashboard — "show me my warranty document"
-- Partial: only rows with a warranty uploaded; stays small, supports index-only scan
-- on warranty_uploaded_at if that's the only column needed.
CREATE INDEX idx_quotes_warranty_claim
  ON public.quotes (claim_id, warranty_uploaded_at)
  WHERE warranty_uploaded_at IS NOT NULL;

-- Index 2 (claims): Contractor dashboard — "Upload Warranty" prompt list
-- completion_date lives on claims (set by mark-job-complete edge function).
-- Composite is more efficient than bitmap-merging the existing separate
-- idx_claims_selected_contractor_id + idx_claims_completion_date indexes.
CREATE 