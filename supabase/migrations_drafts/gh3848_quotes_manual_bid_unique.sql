-- STATUS (gh-1438, as of 2026-11-23T00:39:39Z): NOT APPLIED
-- EVIDENCE: drafted for issue #3848 (follow-up to #3498). Nothing has been run against any database. Production duplicate count is OWED (pre-flight SELECT in supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_pre-flight.md).
-- REPO COPY: none. When applied, file this under supabase/migrations/<ledger version>_gh3848_quotes_manual_bid_unique.sql.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3848_quotes_manual_bid_unique
-- GitHub: #3848 (parent #3498). Rollback: supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_rollback.sql
-- Tier 3: independent REVIEW, APPLY-REVIEW and, if judged 3B, the R-097 notice are owed before any apply.
--
-- What changes: one partial unique index on public.quotes. #3498's idempotency key is per page load, so a contractor who RELOADS
-- and resubmits files a second bid for the same claim and trade. This index makes the database refuse it (SQLSTATE 23505,
-- constraint quotes_manual_bid_uidx); contractor-bid-form.html reads that as "your bid is already in".
--
-- Key: (claim_id, contractor_id, trade_type), the same key quotes_autobid_unique_idx uses for auto-bids. trade_type is in the key
-- because the wizard files one bid per trade on a claim (a contractor legitimately has several bids on one claim).
--
-- Predicate, from what the code writes:
--   is_auto_bid IS NOT TRUE        manual form bids write is_auto_bid=false (contractor-bid-form.html); auto-bids write true and have
--                                  their own index (process-auto-bids). The column is nullable, so NULL counts as manual.
--   renewed_from_quote_id IS NULL  process-bid-expirations' auto-renew path INSERTS the renewal clone (is_auto_bid defaults false,
--                                  bid_status 'active', same claim/contractor/trade) BEFORE it marks the original 'superseded'.
--                                  Without this term the clone would collide with the still-active original and auto-renewal
--                                  would silently fall back to plain expiry. A manual bid is never a renewal clone.
--   bid_status IN ('active','expired')
--                                  the live states. 'cancelled' is what rescind-bid writes (RESCINDED_BID_STATUS; 'rescinded' is not
--                                  admitted by quotes_bid_status_check), and 'superseded' is what renewal/switch-contractor write:
--                                  both are outside the index, so a contractor who rescinded may bid again. 'expired' stays in so a
--                                  fresh bid cannot sit beside an expired one that renew_quote('renew') would flip back to active
--                                  (the form routes an expired bid to Renew, not to a new insert).
-- Rows outside the predicate (auto-bids, renewal clones, cancelled, superseded) are never in the index.
-- Not covered: a manual bid filed while only a renewal clone is live (the clone is outside the index by design).
--
-- Build: plain CREATE UNIQUE INDEX (not CONCURRENTLY: this file runs in a transaction). It takes a SHARE lock on quotes; the table
-- was 12 rows on 2026-11-06 (#3498 pre-flight). lock_timeout makes it give up instead of queueing behind a long write.
-- It FAILS if live duplicates exist: run the pre-flight SELECT first and resolve every group.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS quotes_manual_bid_uidx
  ON public.quotes (claim_id, contractor_id, trade_type)
  WHERE is_auto_bid IS NOT TRUE
    AND renewed_from_quote_id IS NULL
    AND bid_status IN ('active', 'expired');

COMMIT;
