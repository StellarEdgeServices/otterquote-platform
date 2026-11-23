-- STATUS (gh-1438, as of 2026-11-23T00:39:39Z): NOT APPLIED
-- EVIDENCE: drafted for issue #3848 (follow-up to #3498). Nothing has been run against any database. Production duplicate count is OWED (pre-flight SELECT in supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_pre-flight.md).
-- REPO COPY: none. When applied, file this under supabase/migrations/<ledger version>_gh3848_quotes_manual_bid_unique.sql.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3848_quotes_manual_bid_unique
-- GitHub: #3848 (parent #3498). Rollback: supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_rollback.sql
-- Tier 3: independent REVIEW, APPLY-REVIEW and, if judged 3B, the R-097 notice are owed before any apply.
-- ORDER: deploy the process-bid-expirations change in the same PR (renewal-swap.ts) BEFORE this index is applied. Its old order inserted
-- the renewal clone while the original was still active; under this index that insert fails 23505 and auto-renewal silently becomes plain expiry.
--
-- What changes: one partial unique index on public.quotes. #3498's idempotency key is per page load, so a contractor who RELOADS
-- and resubmits files a second bid on the same claim. This index makes the database refuse it (SQLSTATE 23505, constraint
-- quotes_manual_bid_uidx); contractor-bid-form.html reads that as "your bid is already in".
--
-- Key: (claim_id, contractor_id). The form files ONE bid per claim covering the whole trade selection (trade_type is the primary
-- selected trade, contractor-bid-form.html _wizardTradeType), every client lookup assumes one bid per claim and contractor, and
-- trade_type is nullable (NULLs never collide), so trade_type is NOT part of the key.
--
-- Predicate, from what the code writes:
--   is_auto_bid IS NOT TRUE        manual form bids write is_auto_bid=false (contractor-bid-form.html); auto-bids write true
--                                  (process-auto-bids/index.ts:204) and are covered by their own index quotes_autobid_unique_idx.
--                                  The column is nullable, so NULL counts as manual. A live auto-bid beside a live manual bid is
--                                  therefore allowed. (The form never creates that state: the page-load lookup finds the auto-bid
--                                  and opens Change Bid on it; the index simply does not forbid it.)
--   bid_status IN ('active','expired')
--                                  the live states. 'cancelled' is what rescind-bid writes (RESCINDED_BID_STATUS; 'rescinded' is not
--                                  admitted by quotes_bid_status_check), and 'superseded' is what renewal and switch-contractor write:
--                                  both are outside the index, so a contractor who rescinded may bid again. 'expired' stays in so a
--                                  fresh bid cannot sit beside an expired one that renew_quote('renew') flips back to active.
-- Renewal clones (renewed_from_quote_id set) are deliberately INSIDE the index: a live clone is the contractor's bid, and leaving it out
-- let a reload retry file a second bid after every auto-renewal.
--
-- State changes against the index (every writer of quotes.bid_status):
--   insert manual bid (form)              in -> collides with an existing live row (the point).
--   auto-renew (process-bid-expirations)  original superseded FIRST (out), clone inserted (in); clone failure restores the original (in).
--   expiry sweep                          active -> expired (stays in).
--   renew_quote('renew')                  expired -> active (stays in; no new row, cannot collide).
--   renew_quote('reopen')                 cancelled (out) -> active (in): fails 23505 if the contractor has since filed another live bid for
--                                         the claim; the form shows that as "already filed" (not the raw text).
--   rescind-bid / switch-contractor       active -> cancelled / superseded (leave the index).
--
-- Build: plain CREATE UNIQUE INDEX (not CONCURRENTLY: this file runs in a transaction). It takes a SHARE lock on quotes; the table
-- was 12 rows on 2026-11-06 (#3498 pre-flight). lock_timeout makes it give up instead of queueing behind a long write.
-- It FAILS if live duplicates exist: run the pre-flight SELECT first and resolve every group. In-flight renewals that straddle the
-- apply: an old-order function instance that inserts a clone after the index exists fails that insert (clone not created, the
-- original expires normally), which is the old fallback.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS quotes_manual_bid_uidx
  ON public.quotes (claim_id, contractor_id)
  WHERE is_auto_bid IS NOT TRUE
    AND bid_status IN ('active', 'expired');

COMMIT;
