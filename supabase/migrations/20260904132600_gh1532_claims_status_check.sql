-- gh-1532: claims.status on the money-path table has NO CHECK constraint at
-- all today -- any text is accepted. Sources: hazard-register-data-integrity.md:19
-- + hazard-register-security.md:59 ("claims.status has NO CHECK constraint at
-- all... bids.html:2116 writes status: 'awarded'... one row already carries
-- that value"). Filed by CTO cto-2026-09-02T13:45:25Z; tier:3b-approved
-- applied 2026-09-04T13:11:17Z (CTO run cto-2026-09-04T12:07:50Z, R-097
-- window closed without objection).
--
-- Allowed value set per the issue thread (union of what the code can write
-- + the column's own schema DEFAULT -- not a copy of today's SELECT DISTINCT,
-- per the CTO's binding ruling in the approval comment: "Write the allowed
-- set from the product's own state machine... the enumeration is a safety
-- check on it, not its source."):
--   draft             -- repair-intake.html:1310, dashboard.html (insert),
--                         react-app repair-intake/utils.ts, dashboard/use-dashboard-data.ts
--   submitted         -- repair-intake.html:1357, react-app repair-intake/use-repair-intake-data.ts
--   active            -- dashboard.html:3029 (submitForBids), react-app dashboard/actions.ts
--   waitlisted        -- dashboard.html:1839 (D-178 state gate), react-app dashboard/actions.ts
--   bidding           -- supabase/functions/switch-contractor/index.ts,
--                         supabase/functions/process-dunning/index.ts (reset path)
--   contract_signed   -- supabase/functions/docusign-webhook/index.ts (4 sites),
--                         supabase/functions/process-dunning/index.ts (restore path)
--   awarded           -- react-app (homeowner)/bids/actions.ts, accept_bid() RPC
--                         (20260830192051_v116_accept_bid_rpc.sql) -- the value
--                         named in the issue title; confirmed a legitimate,
--                         code-written value, not a mystery/typo
--   documents_needed  -- the column's own DEFAULT (v0-base-schema.sql / baseline
--                         schema line 186: `status text DEFAULT 'documents_needed'`);
--                         zero code write sites but real -- claims land here by
--                         inaction, not by an explicit write
--
-- Live enumeration re-run this session (2026-09-04, prod, read-only) against
-- this 8-value set: 6 distinct values in use (active, bidding,
-- documents_needed, draft, contract_signed, awarded), all 6 within the set.
-- submitted and waitlisted are code-writable but have zero live rows today.
-- No live value falls outside this list -- see the companion pre-flight.md
-- for the full query output and the writer-enumeration cross-check.
--
-- NOT VALID / VALIDATE split per the CTO's ruling on this issue (same shape
-- as gh-1387): if an unexpected legacy row exists, VALIDATE CONSTRAINT fails
-- with a clear error instead of the ALTER itself failing outright.
--
-- Scope note: this migration is the CHECK-constraint half of gh-1532 only.
-- The issue's second half -- guarding accept_bid() with the payment-method
-- check it never reads -- is out of scope for this file per this session's
-- dispatch and per the CTO's own instruction not to let this migration's
-- ceremony delay that guard.
--
-- Rollback: 20260904132600_gh1532_claims_status_check_rollback.sql
-- Pre-flight: 20260904132600_gh1532_claims_status_check_pre-flight.md
--
-- NOT APPLIED by this session. Authored + PR opened only; a separate
-- credentialed/gated step applies this to production.

ALTER TABLE public.claims
  ADD CONSTRAINT claims_status_check
  CHECK (status IN (
    'draft',
    'submitted',
    'active',
    'waitlisted',
    'bidding',
    'contract_signed',
    'awarded',
    'documents_needed'
  )) NOT VALID;

ALTER TABLE public.claims VALIDATE CONSTRAINT claims_status_check;
