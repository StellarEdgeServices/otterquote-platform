# Pre-Flight: gh3848_quotes_manual_bid_unique (DRAFT, NOT APPLIED)

**Forward**: `supabase/migrations_drafts/gh3848_quotes_manual_bid_unique.sql`
**Rollback**: `supabase/migrations_rollbacks/gh3848_quotes_manual_bid_unique_rollback.sql`
**Issue**: #3848 (parent #3498). **Tier**: 3 (index on the bids table); apply only through the Tier 3B path.

## Change
`CREATE UNIQUE INDEX quotes_manual_bid_uidx ON public.quotes (claim_id, contractor_id) WHERE is_auto_bid IS NOT TRUE AND bid_status IN ('active','expired')`.

## Pre-flight (read-only; NOT yet run against production): duplicate groups the index would reject
The index build fails if this returns any row. Expected: 0 rows.
```sql
SELECT claim_id, contractor_id, count(*) AS n,
       array_agg(id ORDER BY created_at) AS quote_ids,
       bool_and(COALESCE(is_test, false)) AS all_test
FROM public.quotes
WHERE is_auto_bid IS NOT TRUE
  AND bid_status IN ('active', 'expired')
GROUP BY claim_id, contractor_id
HAVING count(*) > 1;
```
Count form: `SELECT count(*) FROM (<the query above>) g;`

Also read, for the record: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='quotes';` (confirm no index already covers this and `quotes_manual_bid_uidx` is absent), and the `is_auto_bid` / `renewed_from_quote_id` / `bid_status` columns exist as the baseline schema says.

## Danger patterns
Index without CONCURRENTLY: yes, inside the file's transaction (accepted at this table size; `lock_timeout` 5s). NOT NULL / drop column / type rewrite / rename / truncate / cascade: no. Data written: none.

## Interaction with live code (read, not run)
- ORDER: deploy `process-bid-expirations` (renewal-swap.ts, same PR; NOT deployed by the builder) BEFORE applying. The old order inserted the renewal clone while the original was active; under the index that insert fails and auto-renewal silently becomes plain expiry. Straddling the apply: an old-order instance's clone insert fails and the original expires normally.
- `renew_quote` (supabase/migrations_applied_manually/20261110201420_gh3560_renew_quote_rpc.sql:70-111): 'renew' flips expired -> active on the same row (in the index before and after, cannot collide); 'reopen' flips cancelled -> active and would fail 23505 inside the RPC if the contractor has since filed another live bid for the claim (read, not run). The form shows that as "already filed".
- `rescind-bid` writes `cancelled`; `process-bid-expirations` renewal and `switch-contractor` write `superseded`: all leave the index.
- A live auto-bid beside a live manual bid for the claim and contractor is allowed by the predicate (is_auto_bid IS NOT TRUE).
- Production state of both questions above (duplicate groups; the pg_indexes list) is OWED; nothing was queried.
