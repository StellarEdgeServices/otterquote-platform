-- Rollback for v20-contractor-claim-access.sql
-- Generated 2026-06-08 | Tier 3 deploy required (D-182)
-- Run ONLY after confirming the forward migration is what you're rolling back.
-- Verified 2026-06-08: policy exists in production before this rollback was written.

-- Drop RLS policy added by v20 (contractor claim visibility for their own quotes)

DROP POLICY IF EXISTS "Contractors can view claims for their quotes"
  ON claims;
