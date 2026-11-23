# Pre-Flight: gh3848_quotes_manual_bid_unique (DRAFT, NOT APPLIED)

**Forward**: `supabase/migrations_drafts/gh3848_quotes_manual_bid_unique.sql`
**Rollback**: `supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_rollback.sql`
**Issue**: #3848 (parent #3498). **Tier**: 3 (index on the bids table); apply only through the Tier 3B path.

## Change
`CREATE UNIQUE INDEX quotes_manual_bid_uidx ON public.quotes (claim_id, contractor_id, trade_type) WHERE is_auto_bid IS NOT TRUE AND renewed_from_quote_id IS NULL AND bid_status IN ('active','expired')`.

## Pre-flight (read-only; NOT yet run against production): duplicate groups the index would reject
The index build fails if this returns any row. Expected: 0 rows.
```sql
SELECT claim_id, contractor_id, trade_type, count(*) AS n,
       array_agg(id ORDER BY created_at) AS quote_ids,
       bool_and(COALESCE(is_test, false)) AS all_test
FROM public.quotes
WHERE is_auto_bid IS NOT TRUE
  AND renewed_from_quote_id IS NULL
  AND bid_status IN ('active', 'expired')
GROUP BY claim_id, contractor_id, trade_type
HAVING count(*) > 1;
```
Count form: `SELECT count(*) FROM (<the query above>) g;`

Also read, for the record: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='quotes';` (confirm no index already covers this and `quotes_manual_bid_uidx` is absent), and the `is_auto_bid` / `renewed_from_quote_id` / `bid_status` columns exist as the baseline schema says.

## Danger patterns
Index without CONCURRENTLY: yes, inside the file's transaction (accepted at this table size; `lock_timeout` 5s). NOT NULL / drop column / type rewrite / rename / truncate / cascade: no. Data written: none.

## Interaction with live code (read, not run)
- `process-bid-expirations` auto-renew inserts a clone with `renewed_from_quote_id` set before superseding the original: outside the index by the predicate, so renewal is unaffected.
- `rescind-bid` writes `bid_status='cancelled'`; `renew_quote('reopen')` flips a cancelled bid back to active and would 23505 if a second live manual bid for the same claim/trade exists (read the function body before apply; not read here).
- `react-app/app/contractor/bid/[claimId]/bid-form.tsx` also inserts manual bids and does not yet handle this 23505 (follow-up outside this PR).
