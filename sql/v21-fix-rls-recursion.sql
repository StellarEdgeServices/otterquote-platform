-- v21: Fix infinite RLS recursion on quotes/claims tables
-- Root cause: v20 added "Contractors can view claims for their quotes" policy on the claims
-- table, which queries quotes. The quotes table policy "Homeowners can read quotes for their
-- claims" queries claims. This creates a circular dependency that causes every homeowner
-- quote SELECT to error with "infinite recursion detected in policy for relation quotes."
-- This silently returns no rows, making bids.html show "No Bids Yet" for all homeowners
-- regardless of claim status. (Bug B1 — discovered Session 90, April 9, 2026.)
--
-- Fix: Replace the recursive claims policy with a SECURITY DEFINER function that reads
-- quotes directly, bypassing RLS, so there is no circular reference.
--
-- Applied: April 9, 2026 (Session 90) via Supabase Management API.
-- ClickUp: B1 fix for task 86e0r1pp1 (End-to-end flow testing).

-- Step 1: Create a SECURITY DEFINER function that reads quotes without triggering RLS
CREATE OR REPLACE FUNCTION get_contractor_quote_claim_ids(p_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.claim_id
  FROM quotes q
  JOIN contractors c ON c.id = q.contractor_id
  WHERE c.user_id = p_user_id;
$$;

-- Step 2: Drop the recursive policy and replace it with one that uses the function above
DROP POLICY IF EXISTS "Contractors can view claims for their quotes" ON claims;

CREATE POLICY "Contractors can view claims for their quotes" ON claims
  FOR SELECT TO authenticated
  USING (id IN (SELECT get_contractor_quote_claim_ids(auth.uid())));

-- Verification (run as authenticated homeowner to confirm no more recursion):
-- SET LOCAL ROLE authenticated;
-- SET LOCAL "request.jwt.claims" = '{"sub": "<homeowner-user-id>", "role": "authenticated"}';
-- SELECT id, claim_id, status FROM quotes WHERE claim_id = '<claim-id>';
-- Expected: returns the quote row (previously errored with infinite recursion)
